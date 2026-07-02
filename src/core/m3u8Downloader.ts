import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { formatTime, getErrorMessage } from "#src/common/utils.ts";
import { mergeSegments, parseSegmentInfo } from "#src/core/ffmpeg.ts";
import { M3u8Parser, type ParsedM3u8, type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { downloadSegment } from "#src/core/segmentDownloader.ts";
import type { ImpitOptions } from "impit";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";

export class M3U8Downloader {
    #tempDir: string;
    #tsDir: string;
    #outputFile: string;

    constructor({ workDir, tempDir, tsDir }: Record<string, string>) {
        this.#tempDir = tempDir;
        this.#tsDir = tsDir;
        this.#outputFile = path.join(workDir, `${config.saveName}.mp4`);
    }

    async start(): Promise<void> {
        try {
            logger.log(`文件名称：${config.saveName}`);
            logger.log(`存储路径：${config.workDir}`);
            logger.log(`开始解析：${config.url}`, { colorful: true });

            // 1. 纯解析
            const parser = new M3u8Parser(config.url);
            const { segments, totalDuration, mapInfo, rawMasterContent, rawMediaContent } = await parser.parse();
            this.logM3U8File(rawMasterContent, rawMediaContent);

            logger.log(`文件时长：${formatTime(totalDuration)}`);
            // TODO 自定义分片范围
            logger.log(`总分片：${segments.length}`);

            const isResumable = await this.#initResumableDownload();

            // 3. 处理 MAP 文件的下载与信息读取
            await this.#handleMapAndInfo(mapInfo, isResumable, segments);

            // 4. 批量并发下载切片
            const indexOffset = isResumable ? 0 : mapInfo ? 0 : 1;
            progressTracker.start(segments.length);
            await this.#downloadAllSegments(segments, indexOffset);
            progressTracker.stop();

            // 5. 合并完成
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
        const firstSegmentName = "000000.ts";
        const mapPath = path.join(this.#tempDir, mapFileName);
        const firstSegmentPath = path.join(this.#tsDir, firstSegmentName);

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

    async #downloadAllSegments(segments: Segment[], indexOffset: number): Promise<void> {
        logger.log(`等待下载完成...`, { colorful: true });
        const limit = pLimit(config.concurrency);

        const downloadTasks = segments.map(({ url: tsUrl }, i) => {
            // 根据是否下载首分片对齐索引 // TODO
            const index = i + indexOffset;
            const fileName = `${String(index).padStart(6, "0")}.ts`;
            const filePath = path.join(this.#tsDir, fileName);

            return limit(async () => {
                if (progressTracker.has("success", fileName)) {
                    return;
                }
                const result = await downloadSegment({
                    url: tsUrl,
                    filePath,
                    fileName,
                    maxRetries: config.maxRetries,
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

    async #handleDownloadCompletion(mapInfo: ParsedM3u8["mapInfo"]): Promise<void> {
        const completedCount = progressTracker.size("success");

        console.log("\n");
        const failedSet = progressTracker.get("failed");
        if (failedSet.size === 0) {
            if (!config.noMerge) {
                logger.log("开始调用 ffmpeg 合并分片...\n", { log: false });
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
        const files = await fs.readdir(this.#tsDir);
        await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(this.#tsDir, file);

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

    async #mergeSegmentsWithFFmpeg(mapInfo: ParsedM3u8["mapInfo"]): Promise<void> {
        const downloadedSet = progressTracker.get("success");
        const fileLines: string[] = [...downloadedSet]
            .sort()
            .map((fileName) => `${path.resolve(this.#tsDir, fileName).replace(/\\/g, "/")}`);

        if (mapInfo) {
            fileLines.unshift(`${path.resolve(this.#tempDir, "!MAP.ts").replace(/\\/g, "/")}`);
        }

        try {
            await mergeSegments(fileLines, this.#outputFile);
            logger.log(`🎉 视频封装合并成功: ${this.#outputFile}`);
            if (config.enableDelAfterDone) {
                await logger.close();
                await fs.rm(this.#tempDir, { recursive: true, force: true });
                logger.log("🧹 已清理全部临时缓存分片");
            }
        } catch (err) {
            logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
        }
    }

    logM3U8File(rawMasterContent?: string, rawMediaContent?: string) {
        if (rawMasterContent) {
            logger.file("master.m3u8", rawMasterContent);
        }
        if (rawMediaContent) {
            logger.file("video.m3u8", rawMediaContent);
        }
    }
}
