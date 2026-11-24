import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { parseSegmentInfo } from "#src/core/ffmpeg.ts";
import type { ParsedM3u8, Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { downloadSegment } from "#src/core/segment/downloader.ts";
import { formatFileInfo } from "#src/core/segment/storage.ts";
import type { ImpitOptions } from "impit";
import fs from "node:fs/promises";

async function hasCachedData(filePath: string): Promise<boolean> {
    try {
        const info = await fs.stat(filePath);
        return info.isFile() && info.size > 0;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`无法读取缓存文件 ${filePath}：${getErrorMessage(err)}`, { cause: err });
    }
}

export async function handleMapAndInfo(
    mapInfo: ParsedM3u8["mapInfo"],
    isResumable: boolean,
    segments: Segment[],
    mapPath: string
): Promise<string> {
    logger.log(`开始下载文件`, { colorful: true });

    const { fileName: firstSegmentName, filePath: firstSegmentPath } = formatFileInfo(segments[0].index, config.tsDir);
    if (mapInfo) {
        const cachedMap = isResumable && (await hasCachedData(mapPath));
        if (!cachedMap) {
            logger.log(`下载 MAP 文件...`);
            const headers: ImpitOptions["headers"] = {};
            if (mapInfo.byteRange) {
                const [length, offset = 0] = mapInfo.byteRange.split("@").map(Number);
                headers.Range = `bytes=${offset}-${offset + length - 1}`;
            }
            const result = await downloadSegment({
                url: mapInfo.url,
                filePath: mapPath,
                fileName: "!MAP.ts", // TODO
                headers,
                maxRetries: config.maxRetries,
                keyInfo: mapInfo.keyInfo,
                sanitizeMpegTs: false,
            });
            if (!result.ok) {
                throw new Error("MAP 文件下载失败");
            }
        }
    }

    // 流式断点已包含首片。旧的带 MAP 断点可能没有单独缓存首片。
    const cachedFirst =
        isResumable &&
        (config.streamMerge || progressTracker.has("success", firstSegmentName)) &&
        (await hasCachedData(firstSegmentPath));
    if (!cachedFirst && !(isResumable && config.streamMerge && mapInfo)) {
        logger.log(`下载首分片...`);
        const firstSegment = segments[0]!;
        const result = await downloadSegment({
            url: firstSegment.url,
            filePath: firstSegmentPath,
            fileName: firstSegmentName,
            maxRetries: config.maxRetries,
            keyInfo: firstSegment.keyInfo,
            sanitizeMpegTs: !mapInfo,
        });
        if (!result.ok) {
            throw new Error(`首分片下载失败：${result.failedMessage}`);
        }
        if (!isResumable || !config.streamMerge) {
            progressTracker.add("success", firstSegmentName);
        }
    }

    const segmentPath = mapInfo ? mapPath : firstSegmentPath;
    const segmentInfoText = await parseSegmentInfo(segmentPath);

    logger.log(`读取文件信息...\n${segmentInfoText}`, { colorful: true });
    if (!segmentInfoText) {
        logger.error("未读取到文件信息，可能是已加密或不支持的格式");
    }
    return firstSegmentPath;
}
