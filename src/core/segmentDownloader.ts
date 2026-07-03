import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage, sleep } from "#src/common/utils.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import type { ImpitOptions, ImpitResponse } from "impit";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Segment } from "./m3u8Parser.ts";

export interface DownloadInfo {
    url: string;
    filePath: string;
    fileName: string;
    headers?: ImpitOptions["headers"];
    maxRetries?: number;
    keyInfo?: Segment["keyInfo"];
}

export interface DownloadResult {
    ok: boolean;
    failedMessage: string;
}

// 密钥缓存，防止重复请求
const keyCache = new Map<string, Buffer>();

/**
 * 校验并缓存所有密钥
 * @throws {Error} 如果密钥下载失败或格式不合法，直接抛出异常以中断程序
 */
export async function preflightKeys(segments: Segment[]): Promise<void> {
    const keyUrls = new Set<string>();
    for (const seg of segments) {
        if (seg.keyInfo?.url) {
            keyUrls.add(seg.keyInfo.url);
        }
    }

    if (keyUrls.size === 0) {
        return;
    }

    logger.log(`🔒 检测到加密流，开始预检密钥 (共 ${keyUrls.size} 个)...`, { colorful: true });

    for (const url of keyUrls) {
        try {
            const response = await impit.fetch(url);
            if (!response.ok) {
                throw new Error(`远程服务器返回错误代码 (${response.status})`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const keyBuffer = Buffer.from(arrayBuffer);

            // 标准的 AES-128 Key 必须是 16 字节 (128 比特)
            if (keyBuffer.length !== 16) {
                throw new Error(`非标准的密钥长度！期待 16 字节，实际收到 ${keyBuffer.length} 字节`);
            }

            // 3. 校验通过，直接写入当前模块的内存缓存
            keyCache.set(url, keyBuffer);
            logger.log(`➔ 密钥下载成功并缓存: ${url}`, { print: false });
        } catch (err) {
            // 一旦出错立刻触发 Fail-Fast，抛出包装后的致命错误
            throw new Error(`💥 预检密钥失败! URL: ${url} | 原因: ${getErrorMessage(err)}`);
        }
    }

    logger.log(`预检密钥全部通过`, { colorful: true });
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
 * 清理临时文件并回滚进度条
 */
async function cleanTmpFile(tmpFilePath: string, bytesTrack: number): Promise<void> {
    await fs.unlink(tmpFilePath).catch(() => void 0);
    progressTracker.rollbackBytes(bytesTrack);
}

/**
 * 流式写入与进度追踪
 * @returns 本次下载写入的字节数
 */
async function pipeStreamWithProgress(
    body: ImpitResponse["body"],
    tmpFilePath: string,
    writeFlag: "a" | "w",
    decryptionConfig?: { key: Buffer; iv: Buffer }
): Promise<number> {
    const downloadStream = Readable.fromWeb(body);
    const fileStream = createWriteStream(tmpFilePath, { flags: writeFlag });

    let lastBytesWritten = 0;
    let localBytesTracked = 0;

    const flush = () => {
        const currentBytesWritten = fileStream.bytesWritten;
        const delta = currentBytesWritten - lastBytesWritten;
        if (delta > 0) {
            progressTracker.recordChunk(delta);
            localBytesTracked += delta;
            lastBytesWritten = currentBytesWritten;
        }
        if (fileStream.destroyed) {
            clearInterval(flushTimer);
        }
    };
    const flushTimer = setInterval(flush, 200);

    try {
        if (decryptionConfig) {
            const decipher = crypto.createDecipheriv("aes-128-cbc", decryptionConfig.key, decryptionConfig.iv);

            await pipeline(downloadStream, decipher, fileStream);
        } else {
            await pipeline(downloadStream, fileStream);
        }
        return localBytesTracked;
    } finally {
        flush();
        clearInterval(flushTimer);
    }
}

/**
 * 分片下载模块
 */
export async function downloadSegment(info: DownloadInfo, retryCount = 0, bytesTrack = 0): Promise<DownloadResult> {
    const { url, filePath, fileName, headers = {}, maxRetries = 3, keyInfo } = info;
    const tmpFilePath = `${filePath}.tmp`;
    const tmpFile = fileName.replace(/.[^.]+$/, ".tmp");

    const isEncrypted = keyInfo;
    // 如果是加密文件不启用断点续传
    const hasTmpFile = !isEncrypted && (progressTracker.has("cache", tmpFile) || retryCount);

    const result: DownloadResult = { ok: false, failedMessage: "" };
    const existingSize = hasTmpFile ? await getExistingSize(tmpFilePath) : 0;
    let decryptionConfig: { key: Buffer; iv: Buffer } | undefined = undefined;

    try {
        if (isEncrypted && keyInfo.url && keyInfo.iv) {
            const keyUrl = keyInfo.url;
            const keyBuffer = keyCache.get(keyUrl)!;
            decryptionConfig = { key: keyBuffer, iv: keyInfo.iv };
        }

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
                await cleanTmpFile(tmpFilePath, bytesTrack);
                result.failedMessage = message;
                return result;
            }

            if (status === 416) {
                const isComplete = await handle416Error(response, existingSize, tmpFilePath, filePath, fileName);
                if (isComplete) {
                    result.ok = true;
                    return result;
                }

                await cleanTmpFile(tmpFilePath, bytesTrack);
                bytesTrack = 0;
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

        const downloadedBytes = await pipeStreamWithProgress(response.body, tmpFilePath, writeFlag, decryptionConfig);
        bytesTrack += downloadedBytes;

        // 如果重命名后的路径已存在，则默认覆盖
        await fs.rename(tmpFilePath, filePath);
        result.ok = true;
        return result;
    } catch (err) {
        logger.error(`分片 [${fileName}] 下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

        if (retryCount + 1 < maxRetries) {
            await sleep(1000 * (retryCount + 1));
            return downloadSegment(info, retryCount + 1, bytesTrack);
        } else {
            await cleanTmpFile(tmpFilePath, bytesTrack);
            const message = `分片 [${fileName}] 达到最大重试次数，下载失败`;
            logger.error(message, { print: false });
            result.failedMessage = message;
            return result;
        }
    } finally {
        if (hasTmpFile) {
            progressTracker.delete("cache", tmpFile);
        }
    }
}
