import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage, sleep } from "#src/common/utils.ts";
import { type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import type { ImpitOptions } from "impit";
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
}

interface StreamPipelineOptions {
    segments: Segment[];
    targetStream: NodeJS.WritableStream;
    concurrency: number;
    maxRetries: number;
    initialBuffers?: Buffer[];
    progress?: { count: number };
    startIndex?: number;
    externalSignal?: AbortSignal;
}

/**
 * 流式下载单个分片到内存 Buffer
 */
async function downloadSegmentToBuffer(info: DownloadToBufferOptions, retryCount = 0): Promise<Buffer> {
    const { url, fileName, headers = {}, maxRetries, keyInfo, signal } = info;
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

        return Buffer.concat(chunks);
    } catch (err) {
        progressTracker.rollbackBytes(progressState.bytes);

        if (signal?.aborted) {
            throw err;
        }

        logger.error(`分片 [${fileName}] 内存下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

        if (retryCount + 1 < maxRetries) {
            await sleep(1000 * (retryCount + 1));
            return downloadSegmentToBuffer(info, retryCount + 1);
        } else {
            const message = `分片 [${fileName}] 内存下载达到最大重试次数，下载失败`;
            logger.error(message, { print: false });
            throw new Error(message);
        }
    }
}

/**
 * 并发控制与背压管理管道
 */
export async function pipeSegmentsToStream(options: StreamPipelineOptions): Promise<void> {
    const { segments, targetStream, concurrency, maxRetries, initialBuffers = [], startIndex = 0, externalSignal } = options;

    // 写入首分片
    for (const buf of initialBuffers) {
        const canWrite = targetStream.write(buf);
        if (!canWrite) {
            await new Promise<void>((resolve) => targetStream.once("drain", resolve));
        }
    }

    // 全局取消信号，防止孤儿并发任务浪费带宽与内存
    const controller = new AbortController();
    const { signal } = controller;
    const taskCache = new Map<number, Promise<Buffer | undefined>>();
    // 记录错误源头
    let firstError = null;

    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
    }

    const triggerDownload = (segIndex: number) => {
        if (segIndex < segments.length && !taskCache.has(segIndex)) {
            const seg = segments[segIndex]!;
            const { fileName } = formatFileInfo(seg.index);

            const promise = downloadSegmentToBuffer({
                url: seg.url,
                fileName,
                maxRetries,
                keyInfo: seg.keyInfo,
                signal,
            })
                .then((buf) => {
                    progressTracker.add("success", fileName);
                    progressTracker.print();
                    return buf;
                })
                .catch((err) => {
                    if (!signal.aborted) {
                        progressTracker.add("failed", `分片 [${fileName}] 下载失败`);
                        progressTracker.print();
                        // 记录源头错误
                        firstError = err;
                        // 终止其他并发下载
                        controller.abort();
                    }
                    return undefined; // 防止未处理的Promise拒绝
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

        // 顺序消费并推流
        for (let i = startIndex; i < segments.length; i++) {
            if (i + concurrency - 1 < segments.length) {
                triggerDownload(i + concurrency - 1);
            }

            const buffer = await taskCache.get(i);

            if (buffer === undefined) {
                if (firstError) {
                    throw firstError;
                }
                throw new Error("Operation aborted by user");
            }
            const canWrite = targetStream.write(buffer);
            if (!canWrite) {
                await new Promise<void>((resolve, reject) => {
                    const onDrain = () => {
                        externalSignal?.removeEventListener("abort", onAbort);
                        resolve();
                    };
                    const onAbort = () => {
                        targetStream.removeListener("drain", onDrain);
                        reject(new Error("Operation aborted by user"));
                    };
                    // 处理背压控制，防止 FFmpeg 消费慢导致 Node.js 内存堆积
                    targetStream.once("drain", onDrain);
                    if (externalSignal?.aborted) {
                        onAbort();
                    } else {
                        externalSignal?.addEventListener("abort", onAbort, { once: true });
                    }
                });
            }

            taskCache.delete(i);
            if (options.progress) {
                options.progress.count = i + 1;
            }
        }
    } catch (err) {
        controller.abort();
        throw err;
    }
}
