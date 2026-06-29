import { spawn } from "node:child_process";
import { logger } from "#src/common/logger.ts";

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

export function mergeSegments(listFilePath: string, outputFile: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const ffmpegChild = spawn("ffmpeg", [
            "-hide_banner",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listFilePath,
            "-c",
            "copy",
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

        // 进程关闭时的回调
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
        ffmpegChild.on("error", (err) => {
            reject(err);
        });
    });
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
