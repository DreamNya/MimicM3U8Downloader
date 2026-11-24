import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { formatFFmpegPath, mergeSegments } from "#src/core/ffmpeg.ts";
import type { ParsedM3u8, Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { segmentFailureLimitError } from "#src/core/segment/failureLimit.ts";
import { downloadSegment, formatFileInfo } from "#src/core/segment/index.ts";
import path from "node:path";
import pLimit from "p-limit";

/**
 * 启动传统模式先缓存再合并
 */
export async function startNormalDownload(
    segments: Segment[],
    mapInfo: ParsedM3u8["mapInfo"],
    mapPath: string,
    failureLimit: number | undefined
): Promise<void> {
    progressTracker.start(segments.length);
    await downloadAllSegments(segments.slice(1), !mapInfo, failureLimit);
    progressTracker.stop();

    const failures = progressTracker.get("failed");
    if (failures.size > 0) {
        logger.error([...failures].sort().join("\n"), { log: false });
        logger.warn(`分片下载不完整，共失败 ${failures.size} 片`);
    }
    if (!config.noMerge && (failures.size === 0 || failureLimit !== undefined || config.forceMerge)) {
        await mergeSegmentsWithFFmpeg(segments, mapInfo ? mapPath : undefined);
    }
}

async function downloadAllSegments(segments: Segment[], sanitizeMpegTs: boolean, failureLimit?: number): Promise<void> {
    logger.log(`等待下载完成...`, { colorful: true });
    const limit = pLimit(config.concurrency);
    const controller = new AbortController();
    let stopError: Error | undefined;

    const downloadTasks = segments.map(({ url, keyInfo, index }) => {
        const { fileName, filePath } = formatFileInfo(index, config.tsDir);

        return limit(async () => {
            if (controller.signal.aborted || progressTracker.has("success", fileName)) {
                return;
            }
            try {
                const result = await downloadSegment({
                    url,
                    filePath,
                    fileName,
                    maxRetries: config.maxRetries,
                    keyInfo,
                    sanitizeMpegTs,
                    signal: controller.signal,
                });
                if (result.ok) {
                    progressTracker.add("success", fileName);
                } else if (!controller.signal.aborted) {
                    progressTracker.add("failed", result.failedMessage);
                    if (failureLimit !== undefined && progressTracker.size("failed") > failureLimit) {
                        throw segmentFailureLimitError(failureLimit, new Error(result.failedMessage));
                    }
                }
                progressTracker.print();
            } catch (err) {
                if (controller.signal.aborted) return;
                stopError = err instanceof Error ? err : new Error(getErrorMessage(err));
                controller.abort();
            }
        });
    });

    await Promise.all(downloadTasks);
    if (stopError) {
        throw stopError;
    }
}

async function mergeSegmentsWithFFmpeg(segments: Segment[], mapPath?: string): Promise<void> {
    const skippedIndices: number[] = [];
    const fileLines = segments.flatMap(({ index }) => {
        const { fileName, filePath } = formatFileInfo(index, config.tsDir);
        if (!progressTracker.has("success", fileName)) {
            skippedIndices.push(index);
            return [];
        }
        return [formatFFmpegPath(path.resolve(filePath))];
    });

    if (mapPath) {
        fileLines.unshift(`${formatFFmpegPath(mapPath)}`);
    }

    if (config.debug) {
        logger.file("filelist.json", JSON.stringify(fileLines, null, 2));
    }

    if (skippedIndices.length > 0) {
        logger.warn(`合并时跳过 ${skippedIndices.length} 个下载失败的分片，编号为 ${skippedIndices.join("、")}`);
    }
    logger.log("开始调用 ffmpeg 合并分片...\n", { log: false, colorful: true });
    await mergeSegments(fileLines, config.outputFile);
    logger.log(`🎉 视频封装合并成功: ${config.outputFile}`, { colorful: true });
}
