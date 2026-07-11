import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { formatFFmpegPath, mergeSegments } from "#src/core/ffmpeg.ts";
import type { ParsedM3u8, Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
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
    isResumable: boolean
): Promise<void> {
    progressTracker.start(segments.length);
    const startIndex = isResumable || mapInfo ? 0 : 1;
    // 缓存合并 并发下载并缓存分片
    await downloadAllSegments(segments.slice(startIndex));
    progressTracker.stop();

    // 合并缓存的分片
    await handleDownloadCompletion(mapInfo, mapPath);
}

async function downloadAllSegments(segments: Segment[]): Promise<void> {
    logger.log(`等待下载完成...`, { colorful: true });
    const limit = pLimit(config.concurrency);

    const downloadTasks = segments.map(({ url, keyInfo, index }) => {
        const { fileName, filePath } = formatFileInfo(index, config.tsDir);

        return limit(async () => {
            if (progressTracker.has("success", fileName)) {
                return;
            }
            const result = await downloadSegment({
                url,
                filePath,
                fileName,
                maxRetries: config.maxRetries,
                keyInfo,
            });
            if (result.ok) {
                progressTracker.add("success", fileName);
            } else {
                progressTracker.add("failed", result.failedMessage);
            }
            progressTracker.print();
        });
    });

    await Promise.all(downloadTasks);
}

async function handleDownloadCompletion(mapInfo: ParsedM3u8["mapInfo"], mapPath: string): Promise<void> {
    const completedCount = progressTracker.size("success");

    console.log("\n");
    const failedSet = progressTracker.get("failed");
    if (failedSet.size === 0) {
        if (!config.noMerge) {
            logger.log("开始调用 ffmpeg 合并分片...\n", { log: false, colorful: true });
            await mergeSegmentsWithFFmpeg(mapInfo, mapPath);
        }
    } else {
        logger.error([...failedSet].sort().join("\n"), { log: false });
        logger.warn(`⚠️ 分片下载不完整：${completedCount}`);
        if (!config.noMerge && config.forceMerge) {
            logger.log("forceMerge == true ➔ 开始强制封装已下载分片...");
            await mergeSegmentsWithFFmpeg(mapInfo, mapPath);
        }
    }
}

async function mergeSegmentsWithFFmpeg(mapInfo: ParsedM3u8["mapInfo"], mapPath: string): Promise<void> {
    const downloadedSet = progressTracker.get("success");
    const fileLines: string[] = [...downloadedSet]
        .sort()
        .map((fileName) => `${formatFFmpegPath(path.resolve(config.tsDir, fileName))}`);

    if (mapInfo) {
        fileLines.unshift(`${formatFFmpegPath(mapPath)}`);
    }

    if (config.debug) {
        logger.file("filelist.json", JSON.stringify(fileLines, null, 2));
    }

    try {
        await mergeSegments(fileLines, config.outputFile);
        logger.log(`🎉 视频封装合并成功: ${config.outputFile}`, { colorful: true });
    } catch (err) {
        logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
    }
}
