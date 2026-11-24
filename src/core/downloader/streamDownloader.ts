import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { concatMP4Parts, formatFFmpegPath, startStreamMerge } from "#src/core/ffmpeg.ts";
import type { Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { segmentFailureLimitError } from "#src/core/segment/failureLimit.ts";
import { downloadSegmentsInOrder, writeStreamMergeState, type StreamMergeState } from "#src/core/segment/index.ts";
import { FMP4Timeline, readFMP4Checkpoint, type FMP4Checkpoint } from "#src/core/transform/fMP4.ts";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

interface StreamMergeOptions {
    segments: Segment[];
    streamState: StreamMergeState | null;
    mapPath?: string;
    firstSegmentPath: string;
    stateFilePath: string;
    fMP4FilePath: string;
    failureLimit?: number;
}

function openStreamPart(filePath: string, useFMP4: boolean, previous?: FMP4Checkpoint) {
    const { stdin, stdout, processExitPromise } = startStreamMerge(filePath, useFMP4);
    stdin.on("error", () => {}); // 写入回调和 FFmpeg 退出状态会报告错误。
    const timeline = useFMP4 ? new FMP4Timeline(previous) : undefined;
    const output = timeline
        ? pipeline(stdout, timeline, createWriteStream(filePath, { flags: previous ? "a" : "w" }))
        : Promise.resolve();
    const completion = Promise.all([processExitPromise, output]).catch((err) => {
        stdin.destroy();
        throw err;
    });
    void completion.catch(() => {}); // 写入期间也可能提前退出。

    return {
        filePath,
        write(buffer: Buffer): Promise<void> {
            return new Promise((resolve, reject) => stdin.write(buffer, (err) => err ? reject(err) : resolve()));
        },
        async finish(): Promise<FMP4Checkpoint | undefined> {
            stdin.end();
            await completion;
            return timeline?.checkpoint((await fs.stat(filePath)).size);
        },
        async rollback(): Promise<void> {
            stdin.destroy();
            await Promise.allSettled([processExitPromise, output]);
            if (previous) {
                await fs.truncate(filePath, previous.byteLength);
            } else {
                await fs.rm(filePath, { force: true });
            }
        },
    };
}

export async function streamMergeWithFFmpeg(options: StreamMergeOptions): Promise<{ skipCleanup: boolean }> {
    const { segments, streamState, mapPath, firstSegmentPath, stateFilePath, fMP4FilePath, failureLimit } = options;
    const useFMP4 = config.streamMergeFMP4;
    let nextOffset = streamState?.nextOffset ?? 0;
    const previouslySkipped = streamState?.skippedCount ?? 0;
    const skipCandidates: number[] = [];
    let skipsBeforeLastWrite = 0;
    let confirmedSkips = 0;
    let parts = streamState?.parts ?? [];
    let fmp4 = streamState?.fmp4;
    if (failureLimit !== undefined && previouslySkipped > failureLimit) {
        throw segmentFailureLimitError(failureLimit);
    }

    logger.log(`已启用流式合并模式${useFMP4 ? "(fMP4)" : ""}...\n`, { colorful: true });
    if (previouslySkipped > 0) {
        logger.warn(`续传前的流式合并已跳过 ${previouslySkipped} 个下载失败的分片`);
    }
    if (useFMP4 && nextOffset > 0) {
        fmp4 ??= await readFMP4Checkpoint(fMP4FilePath);
        const { size } = await fs.stat(fMP4FilePath);
        if (!Number.isSafeInteger(fmp4.byteLength) || fmp4.byteLength <= 0 || size < fmp4.byteLength) {
            throw new Error("fMP4 文件大小与断点记录不符");
        }
        if (size > fmp4.byteLength) {
            await fs.truncate(fMP4FilePath, fmp4.byteLength);
        }
    }

    const mapBuffer = nextOffset < segments.length && mapPath ? await fs.readFile(mapPath) : undefined;
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.on("SIGINT", onInterrupt);
    const active: { part?: ReturnType<typeof openStreamPart> } = {};
    let downloadError: Error | undefined;

    const writeSegment = async (buffer: Buffer): Promise<void> => {
        if (!active.part) {
            const filePath = useFMP4 ? fMP4FilePath : path.join(config.tempDir, `part_${parts.length}.mp4`);
            active.part = openStreamPart(filePath, useFMP4, fmp4);
            if (mapBuffer) await active.part.write(mapBuffer);
        }
        await active.part.write(buffer);
    };

    const saveCheckpoint = async (): Promise<void> => {
        const { part } = active;
        if (!part) return;
        const nextFMP4 = await part.finish();
        const nextParts = useFMP4 ? [part.filePath] : [...parts, part.filePath];
        await writeStreamMergeState(stateFilePath, {
            useFMP4,
            nextOffset,
            totalSegments: segments.length,
            parts: nextParts,
            skippedCount: previouslySkipped + skipsBeforeLastWrite,
            fmp4: nextFMP4,
        });
        const firstNewSkip = confirmedSkips;
        confirmedSkips = skipsBeforeLastWrite;
        parts = nextParts;
        fmp4 = nextFMP4;
        active.part = undefined;
        for (let i = firstNewSkip; i < confirmedSkips; i++) {
            logger.warn(`流式合并中跳过下载失败的分片 [${skipCandidates[i]}]，累计跳过 ${previouslySkipped + i + 1} 片`);
        }
        if (confirmedSkips > firstNewSkip) {
            progressTracker.setSkippedCount(previouslySkipped + confirmedSkips);
            progressTracker.print();
        }
    };

    try {
        progressTracker.start(segments.length, {
            completedBeforeRun: nextOffset - previouslySkipped,
            skippedCount: previouslySkipped,
        });
        progressTracker.print();
        if (nextOffset === 0) {
            await writeSegment(await fs.readFile(firstSegmentPath));
            nextOffset = 1;
        }

        for await (const result of downloadSegmentsInOrder({
            segments,
            startIndex: nextOffset,
            concurrency: config.concurrency,
            maxRetries: config.maxRetries,
            signal: controller.signal,
            sanitizeMpegTs: !mapPath,
            failFast: failureLimit === undefined,
        })) {
            if ("error" in result) {
                // 待确认的失败也占用本轮容差，避免连续失败绕过上限。
                if (failureLimit === undefined || previouslySkipped + skipCandidates.length >= failureLimit) {
                    downloadError = failureLimit === undefined
                        ? result.error
                        : segmentFailureLimitError(failureLimit, result.error);
                    break;
                }

                const index = segments[result.index].index;
                // 先保存缺片前的 fMP4，后续分片封装成功时才确认这次跳过。
                if (useFMP4 && active.part) await saveCheckpoint();
                skipCandidates.push(index);
                logger.warn(`分片 [${index}] 下载失败，等待后续分片封装成功后确认跳过`);
            } else {
                await writeSegment(result.buffer);
                nextOffset = result.index + 1;
                skipsBeforeLastWrite = skipCandidates.length;
            }
        }

        await saveCheckpoint();
        progressTracker.stop();
        if (downloadError) throw downloadError;
        if (controller.signal.aborted) {
            logger.log("流式合并已保存当前断点", { colorful: true });
            return { skipCleanup: true };
        }
        const trailingFailures = skipCandidates.length - confirmedSkips;
        if (trailingFailures > 0) {
            throw new Error(`末尾 ${trailingFailures} 个分片下载失败，已保存断点，续传时将重新下载`);
        }
        if (parts.length === 0) throw new Error("没有可用的流式合并产物");
        if (confirmedSkips > 0) {
            logger.warn(`本轮流式合并跳过 ${confirmedSkips} 个下载失败的分片，编号为 ${skipCandidates.join("、")}`);
        }

        if (useFMP4 || (parts.length === 1 && (!streamState || config.streamMergeForceMerge))) {
            await fs.rename(parts[0], config.outputFile);
        } else if (config.streamMergeForceMerge) {
            await handleConcatMP4Parts(parts, config.outputFile);
        } else {
            return { skipCleanup: await renameAllParts(parts, stateFilePath) };
        }

        await fs.rm(stateFilePath, { force: true });
        logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });
        return { skipCleanup: false };
    } catch (err) {
        await active.part?.rollback();
        throw err;
    } finally {
        progressTracker.stop();
        process.off("SIGINT", onInterrupt);
    }
}

async function handleConcatMP4Parts(partPaths: string[], outputFile: string): Promise<void> {
    const concatContent = partPaths.map((p) => `file '${formatFFmpegPath(path.resolve(p))}'`).join("\n");
    const concatPath = path.join(config.tempDir, `concat_parts_${Date.now()}.txt`);
    await fs.writeFile(concatPath, concatContent, "utf-8");
    await concatMP4Parts(concatPath, outputFile);
}

async function renameAllParts(allParts: string[], stateFilePath: string): Promise<boolean> {
    let hasError = false;
    for (const part of allParts) {
        const fileName = path.basename(part);
        const outputFile = path.join(config.workDir, `${config.saveName}.${fileName}`);
        await fs.rename(part, outputFile)
            .then(() => logger.log(`🎉 视频流式片段已写入 : ${outputFile}`, { colorful: true }))
            .catch(() => {
                hasError = true;
                logger.log(`视频流式片段写入失败，请尝试手动移动并重命名：${part}`, { colorful: true });
            });
    }
    await fs.rm(stateFilePath, { force: true });
    return hasError;
}
