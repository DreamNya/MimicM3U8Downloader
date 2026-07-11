import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { parseSegmentInfo, type SegmentInfo } from "#src/core/ffmpeg.ts";
import type { ParsedM3u8, Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { downloadSegment } from "#src/core/segment/downloader.ts";
import { formatFileInfo } from "#src/core/segment/storage.ts";
import type { ImpitOptions } from "impit";

export async function handleMapAndInfo(
    mapInfo: ParsedM3u8["mapInfo"],
    isResumable: boolean,
    segments: Segment[],
    mapPath: string
): Promise<{ initFilePath: string; segmentInfo: SegmentInfo }> {
    logger.log(`开始下载文件`, { colorful: true });

    const { fileName: firstSegmentName, filePath: firstSegmentPath } = formatFileInfo(segments[0].index, config.tsDir);
    const initFilePath: string = mapInfo ? mapPath : firstSegmentPath;

    if (!isResumable) {
        // 如果包含 MAP 则以 MAP为首分片读取视频信息
        if (mapInfo) {
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
            });
            if (!result.ok) {
                throw new Error("MAP 文件下载失败");
            }
        }
        // 不包含 MAP，下载首分片用以读取视频信息
        else {
            logger.log(`下载首分片...`);
            const firstSegment = segments[0];
            if (firstSegment) {
                const result = await downloadSegment({
                    url: firstSegment.url,
                    filePath: firstSegmentPath,
                    fileName: firstSegmentName,
                    maxRetries: config.maxRetries,
                    keyInfo: firstSegment.keyInfo,
                });
                if (result.ok) {
                    progressTracker.add("success", firstSegmentName);
                } else {
                    throw new Error("首分片下载失败");
                }
            }
        }
    }

    const segmentPath = mapInfo ? mapPath : firstSegmentPath;
    const segmentInfo = await parseSegmentInfo(segmentPath);
    const { info: segmentInfoText } = segmentInfo;

    logger.log(`读取文件信息...\n${segmentInfoText}`, { colorful: true });
    if (!segmentInfoText) {
        logger.error("未读取到文件信息，可能是已加密或不支持的格式");
    }
    return { initFilePath, segmentInfo };
}
