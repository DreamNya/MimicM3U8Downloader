import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { type Writable, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function parseSegmentInfo(filePath: string): Promise<string> {
    const info = await getVideoInfo(filePath);
    const lines = info.split(/\r?\n/);
    const result = [];

    const regexPattern = /Stream #\d+:\d+\[(0x[0-9a-fA-F]+)\](?:\([a-zA-Z]+\))?:\s*(Video|Audio|Data):\s*(.*)/;

    for (const line of lines) {
        if (line.includes("Stream #")) {
            const match = line.match(regexPattern);

            if (match) {
                const pid = match[1]; // 提取 0x100
                const type = match[2]; // 提取 Video/Audio/Data
                const content = match[3]; // 提取详细描述

                // 去除编码格式多余参数
                const cleanedContent = content.replace(/\s*\([^)]+\)\s*\([^)]+\)/g, "").replace(/, start [ .\d]+/, "");

                result.push(`PID ${pid}: ${type} ${cleanedContent.trim()}`);
            }
        }
    }
    return result.join("\n");
}

function createFFmpegMergeProcess(outputFile: string): {
    stdin: Writable;
    processExitPromise: Promise<void>;
} {
    const ffmpegChild = spawn("ffmpeg", [
        "-hide_banner",
        "-i",
        "pipe:0", // 从标准输入管道接收流
        "-c",
        "copy", // 仅封装，不重编码
        outputFile,
        "-y",
    ]);

    // 在内存中缓存所有日志
    let ffmpegLogBuffer = "";

    // FFmpeg 的进度和日志绝大部分都在 stderr 流中
    ffmpegChild.stderr.on("data", (chunk: Buffer) => {
        // 实时输出到 CMD 窗口
        process.stderr.write(chunk);
        // 累加到内存缓冲区中
        ffmpegLogBuffer += chunk.toString();
    });

    ffmpegChild.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        ffmpegLogBuffer += chunk.toString();
    });

    const processExitPromise = new Promise<void>((resolve, reject) => {
        ffmpegChild.on("close", (code) => {
            if (ffmpegLogBuffer.trim()) {
                logger.log(
                    `\n==================== FFmpeg 封装日志 ====================\n${ffmpegLogBuffer}\n========================================================`,
                    { print: false }
                );
            }
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg 进程异常退出，退出码: ${code}`));
            }
        });
        ffmpegChild.on("error", reject);
    });

    return {
        stdin: ffmpegChild.stdin!,
        processExitPromise,
    };
}

export async function mergeSegments(filePaths: string[], outputFile: string): Promise<void> {
    const { stdin, processExitPromise } = createFFmpegMergeProcess(outputFile);

    // 定义一个异步生成器，按顺序读取并吐出每个文件的二进制数据
    async function* mergeGenerator() {
        for (const filePath of filePaths) {
            const readStream = fs.createReadStream(filePath);

            // 使用 for await 顺次读取当前文件的每一个chunk
            for await (const chunk of readStream) {
                yield chunk;
            }
        }
    }

    try {
        // pipeline 会在数据全部推完后，自动调用 ffmpegChild.stdin.end()
        await pipeline(Readable.from(mergeGenerator()), stdin);
        await processExitPromise;
    } catch (err) {
        logger.error(`pipeline发生错误: ${getErrorMessage(err)}`);
        // 发生错误时确保关闭管道，防止 FFmpeg 挂起
        stdin.destroy();
        throw err;
    }
}

/**
 * 启动流式 FFmpeg 封装进程
 * @returns 返回输入流 stdin 和进程结束的 Promise
 */
export function startStreamMerge(outputFile: string) {
    return createFFmpegMergeProcess(outputFile);
}

function getVideoInfo(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-i", filePath]);

        let stderrData = "";

        ffmpeg.stderr.on("data", (chunk) => {
            stderrData += chunk.toString();
        });

        ffmpeg.on("close", (code) => {
            if (stderrData.trim()) {
                resolve(stderrData);
            } else {
                reject(new Error(`ffmpeg 异常退出，退出码: ${code}`));
            }
        });

        ffmpeg.on("error", (err) => {
            reject(err);
        });
    });
}

export function formatFFmpegPath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
}
