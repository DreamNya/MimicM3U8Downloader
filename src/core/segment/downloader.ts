import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage, sleep } from "#src/common/utils.ts";
import { type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { createSegmentStream } from "#src/core/segment/crypto.ts";
import type { ImpitOptions, ImpitResponse } from "impit";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export interface DownloadInfo {
    url: string;
    filePath: string;
    fileName: string;
    headers?: ImpitOptions["headers"];
    maxRetries: number;
    keyInfo?: Segment["keyInfo"];
}

export interface DownloadResult {
    ok: boolean;
    failedMessage: string;
}

export interface ProgressState {
    bytes: number;
}

/**
 * 获取临时文件大小
 */
async function getExistingSize(tmpFilePath: string): Promise<number> {
    try {
        const stat = await fs.stat(tmpFilePath);
        return stat.size;
    } catch {
        return 0;
    }
}

/**
 * 处理 416 Range Not Satisfiable 错误
 */
async function handle416Error(
    response: ImpitResponse,
    existingSize: number,
    tmpFilePath: string,
    filePath: string,
    fileName: string
): Promise<boolean> {
    const contentRange = response.headers.get("content-range") || "";
    const match = contentRange.match(/\/(\d+)$/);
    const serverSize = match ? parseInt(match[1], 10) : -1;

    logger.warn(`分片 [${fileName}] 远程服务器返回错误 (416)，本地缓存(${existingSize}) 服务器返回(${serverSize})`, {
        print: false,
    });

    if (serverSize > 0 && existingSize === serverSize) {
        logger.warn(`分片 [${fileName}] 本地缓存完整，完成下载`, { print: false });
        await fs.rename(tmpFilePath, filePath);
        return true;
    }

    logger.warn(`分片 [${fileName}] 本地缓存与服务器返回不符，清空临时文件重新下载`, { print: false });
    return false;
}

/**
 * 清理临时文件 ~~并回滚进度条~~
 */
async function cleanTmpFile(tmpFilePath: string /* , bytesTrack: number */): Promise<void> {
    await fs.unlink(tmpFilePath).catch(() => void 0);
    /* progressTracker.rollbackBytes(bytesTrack); */
}

/**
 * 流式写入与进度追踪
 * @returns 本次下载写入的字节数
 */
async function pipeStreamWithProgress(
    body: ImpitResponse["body"],
    tmpFilePath: string,
    writeFlag: "a" | "w",
    progressState: ProgressState,
    keyInfo?: Segment["keyInfo"]
): Promise<void> {
    const inputStream = createSegmentStream(body, keyInfo);
    const fileStream = createWriteStream(tmpFilePath, { flags: writeFlag });

    let lastBytesWritten = 0;

    const flush = () => {
        const currentBytesWritten = fileStream.bytesWritten;
        const delta = currentBytesWritten - lastBytesWritten;
        if (delta > 0) {
            progressTracker.recordChunk(delta);
            progressState.bytes += delta;
            lastBytesWritten = currentBytesWritten;
        }
        if (fileStream.destroyed) {
            clearInterval(flushTimer);
        }
    };
    const flushTimer = setInterval(flush, 200);

    try {
        await pipeline(inputStream, fileStream);
    } finally {
        flush();
        clearInterval(flushTimer);
    }
}

/**
 * 分片下载模块
 */
export async function downloadSegment(info: DownloadInfo, retryCount = 0): Promise<DownloadResult> {
    const { url, filePath, fileName, headers = {}, maxRetries, keyInfo } = info;
    const tmpFilePath = `${filePath}.tmp`;
    const tmpFileName = path.parse(fileName).name + ".tmp";

    const isEncrypted = keyInfo;
    // 如果是加密文件不启用断点续传
    const hasTmpFile = !isEncrypted && (progressTracker.has("cache", tmpFileName) || retryCount);

    const result: DownloadResult = { ok: false, failedMessage: "" };
    const existingSize = hasTmpFile ? await getExistingSize(tmpFilePath) : 0;

    const progressState: ProgressState = { bytes: 0 };

    try {
        const fetchOptions: ImpitOptions = { headers: { ...headers } };
        if (existingSize > 0) {
            logger.log(`分片 [${fileName}] 尝试断点续传： ${existingSize} `, { print: false });
            fetchOptions.headers = { Range: `bytes=${existingSize}-` };
        }

        const response = await impit.fetch(url, fetchOptions);

        if (!response.ok) {
            const status = response.status;
            const message = `分片 [${fileName}] 远程服务器返回错误 (${status})`;

            if (status === 404 || status === 403) {
                logger.error(message, { print: false });
                await cleanTmpFile(tmpFilePath);
                result.failedMessage = message;
                return result;
            }

            if (status === 416) {
                const isComplete = await handle416Error(response, existingSize, tmpFilePath, filePath, fileName);
                if (isComplete) {
                    result.ok = true;
                    return result;
                }

                await cleanTmpFile(tmpFilePath);
                throw new Error("Range 416 error, client auto-reset.");
            }
            throw new Error(message);
        }

        if (!response.body) {
            throw new Error("Response body empty");
        }

        // 判断服务器是否接受断点续传（206 Partial Content）
        const isPartial = response.status === 206;
        // 'a'→追加写入 'w'→覆盖写入
        const writeFlag = isPartial && existingSize > 0 ? "a" : "w";

        if (isPartial) {
            logger.log(`分片 [${fileName}] 开始断点续传`, { print: false });
        } else if (existingSize > 0) {
            logger.log(`分片 [${fileName}] 不支持断点续传`, { print: false });
        }

        await pipeStreamWithProgress(response.body, tmpFilePath, writeFlag, progressState, keyInfo);

        // 如果重命名后的路径已存在，则默认覆盖
        await fs.rename(tmpFilePath, filePath);
        result.ok = true;
        return result;
    } catch (err) {
        progressTracker.rollbackBytes(progressState.bytes);
        logger.error(`分片 [${fileName}] 下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

        if (retryCount + 1 < maxRetries) {
            await sleep(1000 * (retryCount + 1));
            return downloadSegment(info, retryCount + 1);
        } else {
            await cleanTmpFile(tmpFilePath);
            const message = `分片 [${fileName}] 达到最大重试次数，下载失败`;
            logger.error(message, { print: false });
            result.failedMessage = message;
            return result;
        }
    } finally {
        if (hasTmpFile) {
            progressTracker.delete("cache", tmpFileName);
        }
    }
}
