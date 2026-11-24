import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { normalizeMpegTsBuffer } from "#src/core/transform/mpegTs.ts";
import type { ImpitOptions } from "impit";
import { setTimeout as sleep } from "node:timers/promises";
import { createSegmentStream } from "./crypto.ts";
import type { ProgressState } from "./downloader.ts";
import { formatFileInfo } from "./storage.ts";

interface DownloadToBufferOptions {
    url: string;
    fileName: string;
    headers?: ImpitOptions["headers"];
    maxRetries: number;
    keyInfo?: Segment["keyInfo"];
    signal?: AbortSignal;
    sanitizeMpegTs?: boolean;
}

interface OrderedDownloadOptions {
    segments: Segment[];
    concurrency: number;
    maxRetries: number;
    startIndex: number;
    signal: AbortSignal;
    sanitizeMpegTs: boolean;
    failFast: boolean;
}

type SegmentDownload = { index: number; buffer: Buffer } | { index: number; error: Error };

/**
 * 流式下载单个分片到内存 Buffer
 */
async function downloadSegmentToBuffer(info: DownloadToBufferOptions, retryCount = 0): Promise<Buffer> {
    const { url, fileName, headers = {}, maxRetries, keyInfo, signal, sanitizeMpegTs = false } = info;
    const progressState: ProgressState = { bytes: 0 };

    try {
        const response = await impit.fetch(url, { headers, signal });
        if (!response.ok) {
            throw new Error(`远程服务器返回错误 (${response.status})`);
        }
        if (!response.body) {
            throw new Error("Response body empty");
        }

        const inputStream = createSegmentStream(response.body, keyInfo);
        const chunks: Buffer[] = [];

        for await (const chunk of inputStream) {
            if (signal?.aborted) {
                throw new Error("Download aborted by sliding window controller");
            }
            const buf = chunk as Buffer;
            chunks.push(buf);
            progressTracker.recordChunk(buf.length);
            progressState.bytes += buf.length;
        }

        const downloadedBuffer = Buffer.concat(chunks);
        if (downloadedBuffer.length === 0) {
            throw new Error("Response body empty");
        }

        if (!sanitizeMpegTs) {
            return downloadedBuffer;
        }

        const result = normalizeMpegTsBuffer(downloadedBuffer);

        if (result.offset > 0) {
            logger.warn(`分片 [${fileName}] 检测到伪装前缀，已删除 ${result.offset} 字节`, { print: false });
        }

        return result.data;
    } catch (err) {
        progressTracker.rollbackBytes(progressState.bytes);

        if (signal?.aborted) {
            throw err;
        }

        logger.error(`分片 [${fileName}] 内存下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

        if (retryCount + 1 < maxRetries) {
            await sleep(1000 * (retryCount + 1), undefined, { signal });
            return downloadSegmentToBuffer(info, retryCount + 1);
        } else {
            const message = `分片 [${fileName}] 内存下载达到最大重试次数，下载失败`;
            logger.error(message, { print: false });
            throw new Error(message, { cause: err });
        }
    }
}

/**
 * 滑动窗口并发下载，按播放列表顺序消费结果。
 */
export async function* downloadSegmentsInOrder(options: OrderedDownloadOptions): AsyncGenerator<SegmentDownload> {
    const { segments, concurrency, maxRetries, startIndex, sanitizeMpegTs, failFast } = options;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.signal]);
    const taskCache = new Map<number, Promise<SegmentDownload>>();
    let firstFailure: SegmentDownload | undefined;

    const triggerDownload = (segIndex: number) => {
        if (segIndex < segments.length && !signal.aborted) {
            const seg = segments[segIndex]!;
            const { fileName } = formatFileInfo(seg.index);

            const promise = downloadSegmentToBuffer({
                url: seg.url,
                fileName,
                maxRetries,
                keyInfo: seg.keyInfo,
                signal,
                sanitizeMpegTs,
            })
                .then((buf) => {
                    progressTracker.add("success", fileName);
                    progressTracker.print();
                    return { index: segIndex, buffer: buf };
                })
                .catch((err: unknown) => {
                    const failure = { index: segIndex, error: new Error(getErrorMessage(err), { cause: err }) };
                    if (!signal.aborted) {
                        progressTracker.add("failed", `分片 [${fileName}] 下载失败`);
                        progressTracker.print();
                        if (failFast) {
                            firstFailure = failure;
                            controller.abort();
                        }
                    }
                    return failure;
                });

            taskCache.set(segIndex, promise);
        }
    };

    try {
        const maxInitialLength = Math.min(startIndex + concurrency, segments.length);
        // 预填满初始并发池
        for (let i = startIndex; i < maxInitialLength; i++) {
            triggerDownload(i);
        }

        for (let i = startIndex; i < segments.length; i++) {
            const result = await taskCache.get(i);
            if (options.signal.aborted) {
                return;
            }
            if (firstFailure) {
                yield firstFailure;
                return;
            }
            yield result!;
            taskCache.delete(i);
            triggerDownload(i + concurrency);
        }
    } finally {
        controller.abort();
        await Promise.allSettled(taskCache.values());
    }
}
