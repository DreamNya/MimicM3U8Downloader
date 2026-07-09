import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { formatTime, getErrorMessage } from "#src/common/utils.ts";
import { formatFFmpegPath, mergeSegments, parseSegmentInfo, startStreamMerge } from "#src/core/ffmpeg.ts";
import { M3u8Parser, type ParsedM3u8, type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import {
    downloadSegment,
    filterSegmentsByRange,
    formatFileInfo,
    initResumableDownload,
    pipeSegmentsToStream,
    preflightKeys,
} from "#src/core/segment/index.ts";
import type { ImpitOptions } from "impit";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";

export class M3U8Downloader {
    #mapFileName = "!MAP.ts";
    #mapPath: string;
    #initFilePath: string | null = null;

    constructor() {
        this.#mapPath = path.join(config.tempDir, this.#mapFileName);
    }
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
            const segments: Segment[] = filterSegmentsByRange(config.range, rawSegments);
            const totalDuration: number = segments.reduce((duration, segment) => duration + segment.duration, 0);
            this.logFiles(segments, rawMasterContent, rawMediaContent);

            logger.log(`文件时长：${formatTime(rawTotalDuration)}, 选择时长：${formatTime(totalDuration)}`);
            logger.log(`总分片：${rawSegments.length}, 选择分片：${segments.length}`);

            // 预检密钥
            await preflightKeys(segments);
            // 初始化断点续传 如果开启了流式合并或指定了分片范围则强制全量下载
            const isResumable = config.streamMerge || config.range ? false : await initResumableDownload();

            // 处理 MAP 文件的下载与信息读取
            await this.#handleMapAndInfo(mapInfo, isResumable, segments);

            if (config.streamMerge) {
                // 流式合并 暂不支持progressTracker
                await this.#streamMergeWithFFmpeg(segments);
            } else {
                // 缓存合并
                const indexOffset = isResumable ? 0 : mapInfo ? 0 : 1;
                progressTracker.start(segments.length + indexOffset);
                // 并发下载并缓存分片
                await this.#downloadAllSegments(segments);
                progressTracker.stop();

                // 合并缓存的分片
                await this.#handleDownloadCompletion(mapInfo);
            }
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

        const { fileName: firstSegmentName, filePath: firstSegmentPath } = formatFileInfo(segments[0].index, config.tsDir);

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
                filePath: this.#mapPath,
                fileName: this.#mapFileName,
                headers,
                maxRetries: config.maxRetries,
                keyInfo: mapInfo.keyInfo,
            });
            if (!result.ok) {
                throw new Error("MAP 文件下载失败");
            }
            this.#initFilePath = this.#mapPath;
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
                    maxRetries: config.maxRetries,
                    keyInfo: firstSegment.keyInfo,
                });
                if (result.ok) {
                    progressTracker.add("success", firstSegmentName);
                } else {
                    throw new Error("首分片下载失败");
                }
                this.#initFilePath = firstSegmentPath;
            }
        }

        const segmentPath = mapInfo ? this.#mapPath : firstSegmentPath;
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

    async #mergeSegmentsWithFFmpeg(mapInfo: ParsedM3u8["mapInfo"]): Promise<void> {
        const downloadedSet = progressTracker.get("success");
        const fileLines: string[] = [...downloadedSet]
            .sort()
            .map((fileName) => `${formatFFmpegPath(path.resolve(config.tsDir, fileName))}`);

        if (mapInfo) {
            fileLines.unshift(`${formatFFmpegPath(this.#mapPath)}`);
        }

        if (config.debug) {
            logger.file("filelist.json", JSON.stringify(fileLines, null, 2));
        }

        try {
            await mergeSegments(fileLines, config.outputFile);
            logger.log(`🎉 视频封装合并成功: ${config.outputFile}`, { colorful: true });
            // 是否清理临时文件夹
            if (config.enableDelAfterDone) {
                // logger输出在临时文件夹，此时输出已无意义，因此先关闭日志流
                await logger.close();
                await fs.rm(config.tempDir, { recursive: true, force: true });
                logger.log("🧹 已清理全部临时缓存分片");
            }
        } catch (err) {
            logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
        }
    }

    async #streamMergeWithFFmpeg(segments: Segment[]): Promise<void> {
        logger.log("已启用流式合并模式...\n", { colorful: true });

        if (!this.#initFilePath) {
            throw new Error("未成功加载首分片或 MAP 文件");
        }

        const tmpStreamPath = formatFFmpegPath(path.join(config.tempDir, "stream.tmp.mp4"));
        const { stdin, processExitPromise } = startStreamMerge(tmpStreamPath);

        try {
            const initialBuffers: Buffer[] = [];
            if (this.#initFilePath) {
                const initFileBuffer = await fs.readFile(this.#initFilePath);
                initialBuffers.push(initFileBuffer);
            }

            await pipeSegmentsToStream({
                segments,
                targetStream: stdin,
                concurrency: config.concurrency,
                maxRetries: config.maxRetries,
                initialBuffers,
            });

            // 关闭输入端，触发 FFmpeg 封尾闭合
            stdin.end();
            await processExitPromise;
            await fs.rename(tmpStreamPath, config.outputFile);
            logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });

            if (config.enableDelAfterDone) {
                await logger.close();
                await fs.rm(config.tempDir, { recursive: true, force: true });
                logger.log("🧹 已清理全部临时文件");
            }
        } catch (err) {
            stdin.destroy();
            await processExitPromise;
            await fs.unlink(tmpStreamPath);
            logger.log("流式合并失败，临时文件已删除", { colorful: true });
            logger.warn("流式合并不支持断点续传，对网络稳定性要求较高，请检查网络连接或适当放宽下载配置");
            throw err;
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
