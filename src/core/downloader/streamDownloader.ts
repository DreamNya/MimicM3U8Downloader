import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { concatMP4Parts, formatFFmpegPath, startStreamMerge, type SegmentInfo } from "#src/core/ffmpeg.ts";
import { checkTimescaleMap, completeFMP4Merge, MoofTransform, TimestampAdjuster } from "#src/core/fMP4.ts";
import type { Segment } from "#src/core/m3u8Parser.ts";
import { pipeSegmentsToStream, writeStreamMergeState, type StreamMergeState } from "#src/core/segment/index.ts";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

interface StreamMergeOptions {
    segments: Segment[];
    segmentInfo: SegmentInfo;
    streamState: StreamMergeState | null;
    mapPath: string;
    initFilePath: string;
    stateFilePath: string;
    fMP4FilePath: string;
}

export async function streamMergeWithFFmpeg(options: StreamMergeOptions): Promise<void> {
    // TODO 简化options
    const { segments, segmentInfo, streamState, mapPath, initFilePath, stateFilePath, fMP4FilePath } = options;
    const nextOffset = streamState?.nextOffset ?? 0;
    const previousParts = [...(streamState?.parts ?? [])];
    const useFMP4 = config.streamMergeFMP4;

    logger.log(`已启用流式合并模式${useFMP4 ? "(fMP4)" : ""}...\n`, { colorful: true });

    if (nextOffset === segments.length) {
        if (useFMP4) {
            await completeFMP4Merge(fMP4FilePath, config.outputFile);
        } else {
            if (config.streamMergeForceMerge) {
                await handleConcatMP4Parts(previousParts, config.outputFile);
                logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });
            } else {
                await renameAllParts(previousParts, stateFilePath);
            }
        }
        return;
    }
    if (useFMP4 && nextOffset > 0) {
        if (!checkTimescaleMap(segmentInfo.timescaleMap)) {
            throw new Error("fMP4 视频流/音频流解析失败 无法断点续传");
        }
    }

    const isMapFile = initFilePath === mapPath;
    const startIndex = nextOffset === 0 && !isMapFile ? 1 : nextOffset;
    const streamProgress = { count: startIndex === 1 ? 1 : nextOffset };
    const currentPartIndex = previousParts.length;
    const tmpStreamPath = useFMP4
        ? formatFFmpegPath(fMP4FilePath)
        : formatFFmpegPath(path.join(config.tempDir, `stream.tmp.part_${currentPartIndex}.mp4`));

    const currentDuration =
        useFMP4 && nextOffset > 0 ? segments.slice(0, nextOffset).reduce((sum, seg) => sum + seg.duration, 0) : 0;

    const { stdin, stdout, processExitPromise } = startStreamMerge(tmpStreamPath, useFMP4);

    let fileWriteStream: WriteStream | undefined = undefined;
    let stdoutPipelinePromise: Promise<void> = Promise.resolve();

    if (useFMP4) {
        // 'a' 追加模式; 'w' 覆盖模式
        fileWriteStream = createWriteStream(tmpStreamPath, { flags: nextOffset > 0 ? "a" : "w" });
        const streams =
            nextOffset > 0
                ? [
                      stdout,
                      new MoofTransform(), // 剥离ftyp/moov头
                      new TimestampAdjuster(currentDuration, segmentInfo.timescaleMap), // 修改时间戳偏移
                      fileWriteStream,
                  ]
                : [stdout, fileWriteStream];
        stdoutPipelinePromise = pipeline(streams).catch((err) => {
            console.log("\n");
            logger.error(`🚨 [输出流崩溃] ${getErrorMessage(err)}`, { print: false });
            // 说明数据已污染，直接销毁数据
            stdin.destroy();
            throw err;
        });
    }

    try {
        const initialBuffers: Buffer[] = [];
        if (nextOffset === 0 || isMapFile) {
            if (initFilePath) {
                const initFileBuffer = await fs.readFile(initFilePath);
                initialBuffers.push(initFileBuffer);
            }
        }

        const stdinPipelinePromise = pipeSegmentsToStream({
            segments,
            targetStream: stdin,
            concurrency: config.concurrency,
            maxRetries: config.maxRetries,
            initialBuffers,
            progress: streamProgress,
            startIndex,
        })
            .then(() => {
                if (stdin.writable) {
                    stdin.end();
                }
            })
            .catch((err) => {
                logger.error(`⚠️ [输入流崩溃] 分片下载失败: ${getErrorMessage(err)}`, { print: false });
                // 如果输入流可写则保留数据，否则销毁
                if (stdin.writable) {
                    stdin.end();
                } else {
                    stdin.destroy();
                }
                throw err;
            });

        await Promise.all([stdinPipelinePromise, stdoutPipelinePromise]);
        await processExitPromise;
        if (useFMP4) {
            await completeFMP4Merge(tmpStreamPath, config.outputFile);
        } else {
            if (previousParts.length === 0) {
                await fs.rename(tmpStreamPath, config.outputFile);
            } else {
                const finalPartPath = path.join(config.tempDir, `part_${currentPartIndex}.mp4`);
                await fs.rename(tmpStreamPath, finalPartPath);
                const allParts = [...previousParts, finalPartPath];
                await writeStreamMergeState(stateFilePath, {
                    useFMP4,
                    nextOffset: segments.length,
                    totalSegments: segments.length,
                    parts: allParts,
                });
                if (config.streamMergeForceMerge) {
                    await handleConcatMP4Parts(allParts, config.outputFile);
                } else {
                    await renameAllParts(allParts, stateFilePath);
                    return;
                }
            }
        }

        logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });
    } catch (err) {
        const newOffset = streamProgress.count;

        try {
            await processExitPromise.catch(() => void 0);
            if (useFMP4) {
                if (fileWriteStream?.destroyed === false) {
                    await new Promise((resolve) => fileWriteStream.end(resolve));
                }
                // 将单个临时文件路径保存进 state 结构
                await writeStreamMergeState(stateFilePath, {
                    useFMP4,
                    nextOffset: newOffset,
                    totalSegments: segments.length,
                    parts: [tmpStreamPath],
                });
            } else {
                const savedPartPath = path.join(config.tempDir, `part_${currentPartIndex}.mp4`);
                await fs.rename(tmpStreamPath, savedPartPath);

                await writeStreamMergeState(stateFilePath, {
                    useFMP4,
                    nextOffset: newOffset,
                    totalSegments: segments.length,
                    parts: [...previousParts, savedPartPath],
                });
            }
            logger.log("流式合并失败", { colorful: true });
        } catch (ffmpegErr) {
            stdin.destroy();
            if (useFMP4) {
                await new Promise((resolve) => fileWriteStream!.end(resolve));
            } else {
                await fs.unlink(tmpStreamPath).catch(() => void 0);
            }
            console.log("\n");
            logger.log(`流式合并致命错误，临时文件已删除": ${getErrorMessage(ffmpegErr)}`, { colorful: true });
        }

        throw err;
    }
}

async function handleConcatMP4Parts(partPaths: string[], outputFile: string): Promise<void> {
    const concatContent = partPaths.map((p) => `file '${formatFFmpegPath(path.resolve(p))}'`).join("\n");
    const concatPath = path.join(config.tempDir, `concat_parts_${Date.now()}.txt`);
    await fs.writeFile(concatPath, concatContent, "utf-8");
    await concatMP4Parts(concatPath, outputFile);
}

async function renameAllParts(allParts: string[], stateFilePath: string): Promise<void> {
    for (const part of allParts) {
        const fileName = path.basename(part);
        const outputFile = path.join(config.workDir, `${config.saveName}.${fileName}`);
        await fs.rename(part, outputFile).catch(() => void 0);
        logger.log(`🎉 视频流式片段已写入 : ${outputFile}`, { colorful: true });
    }
    // 清理state文件，防止被重复触发
    await fs.unlink(stateFilePath).catch(() => void 0);
}
