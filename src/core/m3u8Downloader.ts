import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { formatTime, getErrorMessage } from "#src/common/utils.ts";
import { mergeSegments, parseSegmentInfo } from "#src/core/ffmpeg.ts";
import { M3u8Parser, type ParsedM3u8, type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { downloadSegment, preflightKeys } from "#src/core/segmentDownloader.ts";
import type { ImpitOptions } from "impit";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";

export class M3U8Downloader {
    async start(): Promise<void> {
        try {
            logger.log(`文件名称：${config.saveName}`);
            logger.log(`存储路径：${config.workDir}`);
            logger.log(`开始解析：${config.url}`, { colorful: true });

            const parser = new M3u8Parser(config.url);
            const {
                segments: rawSegments,
                totalDuration: rawTotalDuration,
                mapInfo,
                rawMasterContent,
                rawMediaContent,
            } = await parser.parse();
            const segments: Segment[] = this.#filterSegmentsByRange(config.range, rawSegments);
            const totalDuration: number = segments.reduce((duration, segment) => duration + segment.duration, 0);
            this.logFiles(segments, rawMasterContent, rawMediaContent);

            logger.log(`文件时长：${formatTime(rawTotalDuration)}, 选择时长：${formatTime(totalDuration)}`);
            logger.log(`总分片：${rawSegments.length}, 选择分片：${segments.length}`);

            // 预检密钥
            await preflightKeys(segments);
            // 初始化断点续传 如果指定了分片范围则强制全量下载
            const isResumable = config.range ? false : await this.#initResumableDownload();

            // 处理 MAP 文件的下载与信息读取
            await this.#handleMapAndInfo(mapInfo, isResumable, segments);

            // 并发下载切片
            const indexOffset = isResumable ? 0 : mapInfo ? 0 : 1;
            progressTracker.start(segments.length + indexOffset);
            await this.#downloadAllSegments(segments);
            progressTracker.stop();

            // 合并完成
            await this.#handleDownloadCompletion(mapInfo);
        } catch (err) {
            progressTracker.stop();
            logger.error(`\n💥 运行中断: ${getErrorMessage(err)}`);
            throw err;
        }
    }

    async #handleMapAndInfo(mapInfo: ParsedM3u8["mapInfo"], isResumable: boolean, segments: Segment[]): Promise<void> {
        logger.log(`开始下载文件`, { colorful: true });

        if (isResumable) {
            return;
        }

        const mapFileName = "!MAP.ts";
        const mapPath = path.join(config.tempDir, mapFileName);
        const { fileName: firstSegmentName, filePath: firstSegmentPath } = this.#formatFileInfo(segments[0].index, config.tsDir);

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
                fileName: mapFileName,
                headers,
                keyInfo: mapInfo.keyInfo,
            });
            if (!result.ok) {
                throw new Error("首分片下载失败");
            }
        }
        // 不包含 MAP，下载首分片用以读取视频信息
        else {
            logger.log(`下载首分片...`);
            const firstSegment = segments.shift();
            if (firstSegment) {
                const result = await downloadSegment({
                    url: firstSegment.url,
                    filePath: firstSegmentPath,
                    fileName: firstSegmentName,
                    keyInfo: firstSegment.keyInfo,
                });
                if (result.ok) {
                    progressTracker.add("success", firstSegmentName);
                } else {
                    throw new Error("首分片下载失败");
                }
            }
        }

        const segmentPath = mapInfo ? mapPath : firstSegmentPath;
        const segmentInfo = await parseSegmentInfo(segmentPath);
        logger.log(`读取文件信息...\n${segmentInfo}`, { colorful: true });
        if (!segmentInfo) {
            logger.error("未读取到文件信息，可能是已加密或不支持的格式");
        }
    }

    async #downloadAllSegments(segments: Segment[]): Promise<void> {
        logger.log(`等待下载完成...`, { colorful: true });
        const limit = pLimit(config.concurrency);

        const downloadTasks = segments.map(({ url, keyInfo, index }) => {
            const { fileName, filePath } = this.#formatFileInfo(index, config.tsDir);

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

    #formatFileInfo(index: number, dir: string): { fileName: string; filePath: string } {
        const fileName = `${String(index).padStart(6, "0")}.ts`;
        const filePath = path.join(dir, fileName);
        return { fileName, filePath };
    }

    async #handleDownloadCompletion(mapInfo: ParsedM3u8["mapInfo"]): Promise<void> {
        const completedCount = progressTracker.size("success");

        console.log("\n");
        const failedSet = progressTracker.get("failed");
        if (failedSet.size === 0) {
            if (!config.noMerge) {
                logger.log("开始调用 ffmpeg 合并分片...\n", { log: false, colorful: true });
                await this.#mergeSegmentsWithFFmpeg(mapInfo);
            }
        } else {
            logger.error([...failedSet].sort().join("\n"), { log: false });
            logger.warn(`⚠️ 分片下载不完整：${completedCount}`);
            if (!config.noMerge && config.forceMerge) {
                logger.log("forceMerge == true ➔ 开始强制封装已下载分片...");
                await this.#mergeSegmentsWithFFmpeg(mapInfo);
            }
        }
    }

    async #initResumableDownload(): Promise<boolean> {
        const files = await fs.readdir(config.tsDir);
        await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(config.tsDir, file);
                if (file.endsWith(".ts")) {
                    progressTracker.add("success", file);
                    const { size } = await fs.stat(filePath);
                    progressTracker.recordChunk(size);
                } else if (file.endsWith(".tmp")) {
                    progressTracker.add("cache", file);
                }
            })
        );

        const count = progressTracker.size("success");
        if (count > 0) {
            logger.log(`➔ 断点续传分片：${count}`);
            return true;
        }
        return false;
    }

    /**
     * 根据配置的 range 规则过滤分片列表
     */
    #filterSegmentsByRange(rangeStr: string, segments: Segment[]): Segment[] {
        if (!rangeStr) {
            return segments;
        }
        const isTimeRange = rangeStr.includes(":");

        // 1. 时间轴格式解析 (如 "00:00:28-00:10:00")
        if (isTimeRange) {
            const timeToSeconds = (timeStr: string): number => {
                const parts = timeStr.split(":").map(Number);
                if (parts.length !== 3 || parts.some(isNaN)) {
                    throw new Error(`不合法的时间格式: "${timeStr}"，期待格式为 "HH:MM:SS"`);
                }
                return parts[0] * 3600 + parts[1] * 60 + parts[2];
            };

            const parts = rangeStr.split(",");
            const timeRanges: { start: number; end: number }[] = [];

            for (const part of parts) {
                const trimmed = part.trim();
                if (!trimmed) {
                    continue;
                }

                if (trimmed.includes("-")) {
                    const [startStr, endStr] = trimmed.split("-");
                    const start = startStr && startStr.trim() ? timeToSeconds(startStr.trim()) : 0;
                    const end = endStr && endStr.trim() ? timeToSeconds(endStr.trim()) : Infinity;
                    timeRanges.push({ start, end });
                } else {
                    const time = timeToSeconds(trimmed);
                    timeRanges.push({ start: time, end: time });
                }
            }

            let currentRefTime = 0;
            const filtered: Segment[] = [];

            for (const seg of segments) {
                const startTime = currentRefTime;
                const endTime = currentRefTime + seg.duration;
                currentRefTime = endTime; // 递增时间指针

                const matches = timeRanges.some((range) => {
                    if (range.start === range.end) {
                        return startTime <= range.start && range.start < endTime;
                    }
                    // 分片起点小于范围终点 且 分片终点大于范围起点
                    return startTime < range.end && endTime > range.start;
                });

                if (matches) {
                    filtered.push(seg);
                }
            }

            return filtered;
        }
        // 精确分片索引格式解析 (如 "110,120-130")
        else {
            const parts = rangeStr.split(",");
            const exactIndices = new Set<number>();
            const indexRanges: { start: number; end: number }[] = [];

            for (const part of parts) {
                const trimmed = part.trim();
                if (!trimmed) {
                    continue;
                }

                if (trimmed.includes("-")) {
                    const [startStr, endStr] = trimmed.split("-");
                    const start = startStr && startStr.trim() ? parseInt(startStr.trim(), 10) : 0;
                    const end = endStr && endStr.trim() ? parseInt(endStr.trim(), 10) : Infinity;
                    indexRanges.push({ start, end });
                } else {
                    exactIndices.add(parseInt(trimmed, 10));
                }
            }

            return segments.filter((seg) => {
                if (exactIndices.has(seg.index)) {
                    return true;
                }
                return indexRanges.some((range) => seg.index >= range.start && seg.index <= range.end);
            });
        }
    }

    async #mergeSegmentsWithFFmpeg(mapInfo: ParsedM3u8["mapInfo"]): Promise<void> {
        const downloadedSet = progressTracker.get("success");
        const fileLines: string[] = [...downloadedSet]
            .sort()
            .map((fileName) => `${path.resolve(config.tsDir, fileName).replace(/\\/g, "/")}`);

        if (mapInfo) {
            fileLines.unshift(`${path.resolve(config.tempDir, "!MAP.ts").replace(/\\/g, "/")}`);
        }

        if (config.debug) {
            logger.file("filelist.json", JSON.stringify(fileLines, null, 2));
        }

        try {
            await mergeSegments(fileLines, config.outputFile);
            logger.log(`🎉 视频封装合并成功: ${config.outputFile}`, { colorful: true });
            if (config.enableDelAfterDone) {
                await logger.close();
                await fs.rm(config.tempDir, { recursive: true, force: true });
                logger.log("🧹 已清理全部临时缓存分片");
            }
        } catch (err) {
            logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
        }
    }

    logFiles(segments: Segment[], rawMasterContent?: string, rawMediaContent?: string) {
        if (rawMasterContent) {
            logger.file("master.m3u8", rawMasterContent);
        }
        if (rawMediaContent) {
            logger.file("video.m3u8", rawMediaContent);
        }
        if (config.debug) {
            logger.file("segments.json", JSON.stringify(segments, null, 2));
        }
    }
}
