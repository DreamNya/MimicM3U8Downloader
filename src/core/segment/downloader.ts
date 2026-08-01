import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage, sleep } from "#src/common/utils.ts";
import { type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { MpegTsPrefixTransform } from "#src/core/transform/mpegTs.ts";
import type { ImpitOptions, ImpitResponse } from "impit";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createSegmentStream } from "./crypto.ts";

export interface DownloadInfo {
    url: string;
    filePath: string;
    fileName: string;
    headers?: ImpitOptions["headers"];
    maxRetries: number;
    keyInfo?: Segment["keyInfo"];
    sanitizeMpegTs?: boolean;
}

export interface DownloadResult {
    ok: boolean;
    failedMessage: string;
}

export interface ProgressState {
    bytes: number;
}

interface ResumeState {
    localSize: number;
    sourceOffset: number;
    sourceSize: number;
}

type MpegTsDetectedHandler = (offset: number) => void | Promise<void>;

const EMPTY_RESUME_STATE: ResumeState = {
    localSize: 0,
    sourceOffset: 0,
    sourceSize: 0,
};

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
 * 读取断点续传状态
 */
async function getResumeState(
    tmpFilePath: string,
    sourceOffsetPath: string,
    useSourceOffset: boolean,
    fileName: string
): Promise<ResumeState> {
    const localSize = await getExistingSize(tmpFilePath);

    if (localSize <= 0) {
        await fs.unlink(sourceOffsetPath).catch(() => void 0);

        return EMPTY_RESUME_STATE;
    }

    if (!useSourceOffset) {
        return {
            localSize,
            sourceOffset: 0,
            sourceSize: localSize,
        };
    }

    try {
        const content = await fs.readFile(sourceOffsetPath, "utf8");

        const normalizedContent = content.trim();

        // 不直接使用 parseInt("12abc")，避免错误的偏移文件被解析为一个看似有效的数字。
        if (!/^\d+$/.test(normalizedContent)) {
            throw new Error("MPEG-TS source offset is not an integer");
        }

        const sourceOffset = Number(normalizedContent);

        if (!Number.isSafeInteger(sourceOffset) || sourceOffset <= 0) {
            throw new Error("MPEG-TS source offset is invalid");
        }

        return {
            localSize,
            sourceOffset,
            sourceSize: localSize + sourceOffset,
        };
    } catch (err) {
        const error = err as NodeJS.ErrnoException;

        // 没有偏移文件
        if (error.code === "ENOENT") {
            return {
                localSize,
                sourceOffset: 0,
                sourceSize: localSize,
            };
        }

        // 偏移文件损坏时强制重新下载
        logger.warn(`分片 [${fileName}] 的断点续传偏移记录无效，将清空缓存重新下载：${getErrorMessage(err)}`, { print: false });

        await cleanTmpFile(tmpFilePath, sourceOffsetPath);

        return EMPTY_RESUME_STATE;
    }
}

/**
 * 保存或移除 MPEG-TS 伪装前缀的远端偏移记录。
 * 该记录仅用于未加密分片的断点续传。
 */
async function updateSourceOffset(sourceOffsetPath: string, offset: number): Promise<void> {
    if (offset > 0) {
        await fs.writeFile(sourceOffsetPath, String(offset), "utf8");

        return;
    }

    await fs.unlink(sourceOffsetPath).catch(() => void 0);
}

/**
 * 完成临时文件
 */
async function completeTmpFile(tmpFilePath: string, sourceOffsetPath: string, filePath: string): Promise<void> {
    await fs.rename(tmpFilePath, filePath);

    await fs.unlink(sourceOffsetPath).catch(() => void 0);
}

/**
 * 处理 416 Range Not Satisfiable 错误
 */
async function handle416Error(
    response: ImpitResponse,
    resumeState: ResumeState,
    tmpFilePath: string,
    sourceOffsetPath: string,
    filePath: string,
    fileName: string
): Promise<boolean> {
    const contentRange = response.headers.get("content-range") || "";
    const match = contentRange.match(/\/(\d+)$/);
    const serverSize = match ? parseInt(match[1], 10) : -1;

    const localDescription =
        resumeState.sourceOffset > 0
            ? `${resumeState.localSize} + 前缀 ${resumeState.sourceOffset} = ${resumeState.sourceSize}`
            : String(resumeState.localSize);

    logger.warn(`分片 [${fileName}] 远程服务器返回错误 (416)，本地缓存远端大小(${localDescription})，服务器返回(${serverSize})`, {
        print: false,
    });

    if (serverSize > 0 && resumeState.localSize > 0 && resumeState.sourceSize === serverSize) {
        logger.warn(`分片 [${fileName}] 本地缓存完整，完成下载`, { print: false });
        await completeTmpFile(tmpFilePath, sourceOffsetPath, filePath);
        return true;
    }

    logger.warn(`分片 [${fileName}] 本地缓存与服务器返回不符，清空临时文件重新下载`, { print: false });
    return false;
}

/**
 * 清理临时文件 ~~并回滚进度条~~
 */
async function cleanTmpFile(tmpFilePath: string, sourceOffsetPath: string /* , bytesTrack: number */): Promise<void> {
    await Promise.all([fs.unlink(tmpFilePath).catch(() => void 0), fs.unlink(sourceOffsetPath).catch(() => void 0)]);
    /* progressTracker.rollbackBytes(bytesTrack); */
}

/**
 * 流式写入与进度追踪
 */
async function pipeStreamWithProgress(
    body: ImpitResponse["body"],
    tmpFilePath: string,
    writeFlag: "a" | "w",
    progressState: ProgressState,
    keyInfo?: Segment["keyInfo"],
    sanitizeMpegTs = false,
    onMpegTsDetected?: MpegTsDetectedHandler
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
        if (sanitizeMpegTs && writeFlag === "w") {
            const mpegTsTransform = new MpegTsPrefixTransform({
                onDetected: onMpegTsDetected,
            });

            await pipeline(inputStream, mpegTsTransform, fileStream);
        } else {
            await pipeline(inputStream, fileStream);
        }
    } finally {
        flush();
        clearInterval(flushTimer);
    }
}

/**
 * 分片下载模块
 */
export async function downloadSegment(info: DownloadInfo, retryCount = 0): Promise<DownloadResult> {
    const { url, filePath, fileName, headers = {}, maxRetries, keyInfo, sanitizeMpegTs = false } = info;
    const tmpFilePath = `${filePath}.tmp`;
    const sourceOffsetPath = `${tmpFilePath}.source-offset`;
    const tmpFileName = path.parse(fileName).name + ".tmp";

    const isEncrypted = Boolean(keyInfo);
    // 如果是加密文件不启用断点续传
    const hasTmpFile = !isEncrypted && (progressTracker.has("cache", tmpFileName) || retryCount > 0);

    const result: DownloadResult = { ok: false, failedMessage: "" };

    const progressState: ProgressState = { bytes: 0 };

    try {
        const resumeState = hasTmpFile
            ? await getResumeState(tmpFilePath, sourceOffsetPath, sanitizeMpegTs, fileName)
            : EMPTY_RESUME_STATE;

        const fetchOptions: ImpitOptions = { headers: { ...headers } };
        if (resumeState.sourceSize > 0) {
            const resumeDescription =
                resumeState.sourceOffset > 0
                    ? `${resumeState.sourceSize}（本地 ${resumeState.localSize} + 已删除前缀 ${resumeState.sourceOffset}）`
                    : String(resumeState.sourceSize);

            logger.log(`分片 [${fileName}] 尝试断点续传：${resumeDescription}`, { print: false });

            fetchOptions.headers = { ...headers, Range: `bytes=${resumeState.sourceSize}-` };
        }

        const response = await impit.fetch(url, fetchOptions);

        if (!response.ok) {
            const status = response.status;
            const message = `分片 [${fileName}] 远程服务器返回错误 (${status})`;

            if (status === 404 || status === 403) {
                logger.error(message, { print: false });
                await cleanTmpFile(tmpFilePath, sourceOffsetPath);
                result.failedMessage = message;
                return result;
            }

            if (status === 416) {
                const isComplete = await handle416Error(response, resumeState, tmpFilePath, sourceOffsetPath, filePath, fileName);
                if (isComplete) {
                    result.ok = true;
                    return result;
                }

                await cleanTmpFile(tmpFilePath, sourceOffsetPath);
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
        const writeFlag = isPartial && resumeState.localSize > 0 ? "a" : "w";

        if (isPartial) {
            logger.log(`分片 [${fileName}] 开始断点续传`, { print: false });
        } else if (resumeState.localSize > 0) {
            logger.log(`分片 [${fileName}] 不支持断点续传`, { print: false });
        }

        await pipeStreamWithProgress(
            response.body,
            tmpFilePath,
            writeFlag,
            progressState,
            keyInfo,
            sanitizeMpegTs,
            async (offset) => {
                if (offset > 0) {
                    logger.warn(`分片 [${fileName}] 检测到 MPEG-TS 伪装前缀，已删除 ${offset} 字节`, { print: false });
                }

                // 加密分片不会进行断点续传
                if (!isEncrypted) {
                    // 未加密分片，必须在 MPEG-TS 数据开始写入文件前保存偏移，保证续传正确
                    await updateSourceOffset(sourceOffsetPath, offset);
                }
            }
        );

        // 如果重命名后的路径已存在，则默认覆盖
        await completeTmpFile(tmpFilePath, sourceOffsetPath, filePath);
        result.ok = true;
        return result;
    } catch (err) {
        progressTracker.rollbackBytes(progressState.bytes);
        logger.error(`分片 [${fileName}] 下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

        if (retryCount + 1 < maxRetries) {
            await sleep(1000 * (retryCount + 1));
            return downloadSegment(info, retryCount + 1);
        } else {
            await cleanTmpFile(tmpFilePath, sourceOffsetPath);
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
