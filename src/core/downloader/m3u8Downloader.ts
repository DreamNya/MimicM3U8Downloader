import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { formatTime, getErrorMessage } from "#src/common/utils.ts";
import { type SegmentInfo } from "#src/core/ffmpeg.ts";
import { M3u8Parser, type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import { filterSegmentsByRange, initResumableDownload, initStreamMergeState, preflightKeys } from "#src/core/segment/index.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { handleMapAndInfo } from "./metadataHandler.ts";
import { startNormalDownload } from "./normalDownloader.ts";
import { streamMergeWithFFmpeg } from "./streamDownloader.ts";

export class M3U8Downloader {
    readonly #mapFileName = "!MAP.ts";
    readonly #streamMergeStateFileName = "stream_merge_state.json";
    readonly #streamMergeFMP4FileName = "streamMerge.tmp.fmp4.mp4";
    readonly #mapPath: string;
    readonly #stateFilePath: string;
    readonly #fMP4FilePath: string;
    #initFilePath!: string;
    #segmentInfo!: SegmentInfo;

    constructor() {
        this.#mapPath = path.join(config.tempDir, this.#mapFileName);
        this.#stateFilePath = path.join(config.tempDir, this.#streamMergeStateFileName);
        this.#fMP4FilePath = path.join(config.tempDir, this.#streamMergeFMP4FileName);
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
            this.#logFiles(segments, rawMasterContent, rawMediaContent);
            if (segments.length === 0 || totalDuration === 0) {
                throw new Error("解析失败：分片数量为0 或 分片总时长为0");
            }

            logger.log(`文件时长：${formatTime(rawTotalDuration)}, 选择时长：${formatTime(totalDuration)}`);
            logger.log(`总分片：${rawSegments.length}, 选择分片：${segments.length}`);

            // 预检密钥
            await preflightKeys(segments);
            // 预载流式断点状态
            const streamState = config.streamMerge
                ? await initStreamMergeState(this.#stateFilePath, segments.length, config.streamMergeFMP4)
                : null;
            // 初始化断点续传
            const isResumable = config.streamMerge
                ? // 流式断点状态校验
                  streamState !== null && streamState.nextOffset > 0
                : // 如果指定了分片范围则强制全量下载
                  config.range
                  ? false
                  : await initResumableDownload();

            // 处理 MAP 文件的下载与信息读取
            const meta = await handleMapAndInfo(mapInfo, isResumable, segments, this.#mapPath);
            this.#initFilePath = meta.initFilePath;
            this.#segmentInfo = meta.segmentInfo;

            let skipCleanup = false;

            if (config.streamMerge) {
                // 流式合并 暂不支持progressTracker
                const result = await streamMergeWithFFmpeg({
                    segments,
                    segmentInfo: this.#segmentInfo,
                    streamState,
                    mapPath: this.#mapPath,
                    initFilePath: this.#initFilePath,
                    stateFilePath: this.#stateFilePath,
                    fMP4FilePath: this.#fMP4FilePath,
                });
                if (result.skipCleanup) {
                    skipCleanup = true;
                }
            } else {
                await startNormalDownload(segments, mapInfo, this.#mapPath, isResumable);
            }
            await this.#handleDelAfterDone(skipCleanup);
        } catch (err) {
            progressTracker.stop();
            logger.error(`\n💥 运行中断: ${getErrorMessage(err)}`);
            throw err;
        }
    }

    #logFiles(segments: Segment[], rawMasterContent?: string, rawMediaContent?: string): void {
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

    async #handleDelAfterDone(skipCleanup: boolean): Promise<void> {
        // 是否清理临时文件夹
        if (config.enableDelAfterDone) {
            if (skipCleanup) {
                logger.log("🚨 检测到有视频片段未迁移成功，已自动跳过临时文件夹清理以防数据丢失。", { colorful: true });
                return;
            }
            // logger输出在临时文件夹，此时输出已无意义，因此先关闭日志流
            await logger.close();
            await fs.rm(config.tempDir, { recursive: true, force: true });
            logger.log("🧹 已清理临时文件夹及全部缓存分片");
        }
    }
}
