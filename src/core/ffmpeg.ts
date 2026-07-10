import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { type Writable, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 监控 FFmpeg 进程的生命周期与日志输出
 * @param ffmpegChild FFmpeg 子进程
 * @param options 配置项（日志标题、是否捕获 stdout）
 */
function monitorFFmpegProcess(
    ffmpegChild: ReturnType<typeof spawn>,
    options: { logTitle?: string; captureStdout?: boolean } = {}
): Promise<void> {
    const { logTitle = "FFmpeg 运行日志", captureStdout = true } = options;

    // 在内存中缓存所有日志
    let ffmpegLogBuffer = "";

    // FFmpeg 的进度和日志绝大部分都在 stderr 流中
    ffmpegChild.stderr?.on("data", (chunk: Buffer) => {
        // 实时输出到 CMD 窗口
        process.stderr.write(chunk);
        const logStr = chunk.toString();
        // 累加到内存缓冲区中
        ffmpegLogBuffer += logStr;

        // 熔断机制：如果发现 FFmpeg 核心线程已经报错终止，但主进程由于 Pipe Bug 挂起
        if (logStr.includes("Error muxing a packet") || logStr.includes("Task finished with error code")) {
            // 稍作延迟让剩余的错误日志打印完毕，随后强行击杀子进程，打破死锁
            setTimeout(() => {
                ffmpegChild.kill("SIGKILL");
            }, 200);
        }
    });

    if (captureStdout) {
        ffmpegChild.stdout?.on("data", (chunk: Buffer) => {
            process.stdout.write(chunk);
            ffmpegLogBuffer += chunk.toString();
        });
    }

    return new Promise<void>((resolve, reject) => {
        ffmpegChild.on("close", (code) => {
            // 进程结束后，静默写入本地日志文件
            if (ffmpegLogBuffer.trim()) {
                logger.log(
                    `\n==================== ${logTitle} ====================\n${ffmpegLogBuffer}\n========================================================`,
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
}

export interface SegmentInfo {
    info: string;
    timescaleMap: Map<number, number>;
}

export async function parseSegmentInfo(filePath: string): Promise<SegmentInfo> {
    const info = await getVideoInfo(filePath);
    const lines = info.split(/\r?\n/);
    const formattedInfo: string[] = [];
    const timescales: [number, number][] = [];

    const regexPattern = /Stream #\d+:(\d+)(?:\[(0x[0-9a-fA-F]+)\])?(?:\([a-zA-Z]+\))?:\s*(Video|Audio|Data):\s*(.*)/i;

    for (const line of lines) {
        if (line.includes("Stream #")) {
            const match = line.match(regexPattern);

            if (match) {
                const streamIndex = match[1]; // 流索引 (如 0, 1)
                const pid = match[2] || `Index_${streamIndex}`; // TS 有 PID 则用 PID，MP4 没有则用索引替代
                const type = match[3]; // 提取 Video/Audio/Data
                const content = match[4]; // 提取详细描述

                // 提取精确的 timescale (tbn) 如 "90k tbn" 或 "44100 tbn"
                const tbnMatch = content.match(/(\d+(?:\.\d+)?k?)\s*tbn/i);
                let timescaleNum: number | null = null;

                if (tbnMatch) {
                    const tbnStr = tbnMatch[1].toLowerCase();
                    if (tbnStr.endsWith("k")) {
                        // 处理带 'k' 的情况，例如 90k -> 90000
                        timescaleNum = parseFloat(tbnStr) * 1000;
                    } else {
                        timescaleNum = parseInt(tbnStr, 10);
                    }
                } else if (type === "Audio") {
                    // 如果音频流没有 tbn 则 timescale 等于采样率
                    const hzMatch = content.match(/(\d+)\s*Hz/i);
                    if (hzMatch) {
                        timescaleNum = parseInt(hzMatch[1], 10);
                    }
                }

                // [streamIndex, timescale]
                timescales.push([Number(streamIndex) + 1, timescaleNum ?? 0]);
                // 去除编码格式多余参数
                const cleanedContent = content.replace(/\s*\([^)]+\)\s*\([^)]+\)/g, "").replace(/, start [ .\d]+/, "");

                formattedInfo.push(`PID ${pid}: ${type} ${cleanedContent.trim()}`);
            }
        }
    }
    return {
        info: formattedInfo.join("\n"),
        timescaleMap: new Map(timescales),
    };
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

    const processExitPromise = monitorFFmpegProcess(ffmpegChild, { logTitle: "FFmpeg 封装日志" });

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
        await processExitPromise.catch(() => void 0);
        throw err;
    }
}

/**
 * 启动流式 FFmpeg 封装进程
 * @param outputFile 输出路径
 * @param useFMP4 是否启用 fMP4 模式
 * @returns 输入流 stdin、输出流 stdout、进程结束 Promise
 */
export function startStreamMerge(
    outputFile: string,
    useFMP4 = false
): {
    stdin: Writable;
    stdout: Readable;
    processExitPromise: Promise<void>;
} {
    const args = ["-hide_banner", "-i", "pipe:0", "-c", "copy"];

    if (useFMP4) {
        args.push("-bsf:a", "aac_adtstoasc");
        // 配置 fMP4 相关的 movflags，并将结果流输出到 pipe:1 (stdout)
        args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");
    } else {
        args.push(outputFile, "-y");
    }

    const ffmpegChild = spawn("ffmpeg", args);

    const processExitPromise = monitorFFmpegProcess(ffmpegChild, {
        logTitle: "FFmpeg 封装日志",
        // fMP4 模式下，stdout 传输的是视频流二进制数据
        captureStdout: !useFMP4,
    });

    return {
        stdin: ffmpegChild.stdin!,
        stdout: ffmpegChild.stdout!, // 暴露 stdout 供外层 Node.js 流式追加写入
        processExitPromise,
    };
}

function getVideoInfo(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-i", filePath]);

        let stderrData = "";

        ffmpeg.stderr.on("data", (chunk) => {
            stderrData += chunk.toString();
        });

        ffmpeg.on("close", (code) => {
            // 获取信息时 FFmpeg 通常会因为没有输出文件而返回状态码 1，因此不校验 code === 0
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

export function concatMP4Parts(concatPath: string, outputFile: string): Promise<void> {
    const ffmpegChild = spawn("ffmpeg", [
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-c",
        "copy",
        outputFile,
        "-y",
    ]);

    return monitorFFmpegProcess(ffmpegChild, { logTitle: "FFmpeg 流式片段合并日志" });
}
