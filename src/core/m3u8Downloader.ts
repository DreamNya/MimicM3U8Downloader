import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { formatTime, getErrorMessage } from "#src/common/utils.ts";
import {
    concatMP4Parts,
    formatFFmpegPath,
    mergeSegments,
    parseSegmentInfo,
    startStreamMerge,
    type SegmentInfo,
} from "#src/core/ffmpeg.ts";
import { checkTimescaleMap, completeFMP4Merge, MoofTransform, TimestampAdjuster } from "#src/core/fMP4.ts";
import { M3u8Parser, type ParsedM3u8, type Segment } from "#src/core/m3u8Parser.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import {
    downloadSegment,
    filterSegmentsByRange,
    formatFileInfo,
    initResumableDownload,
    initStreamMergeState,
    pipeSegmentsToStream,
    preflightKeys,
    writeStreamMergeState,
    type StreamMergeState,
} from "#src/core/segment/index.ts";
import type { ImpitOptions } from "impit";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pLimit from "p-limit";

export class M3U8Downloader {
    readonly #mapFileName = "!MAP.ts";
    readonly #streamMergeStateFileName = "stream_merge_state.json";
    readonly #streamMergeFMP4FileName = "streamMerge.tmp.fmp4.mp4";
    readonly #mapPath: string;
    readonly #stateFilePath: string;
    readonly #fMP4FilePath: string;
    #initFilePath: string | null = null;
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
            await this.#handleMapAndInfo(mapInfo, isResumable, segments);

            if (config.streamMerge) {
                // 流式合并 暂不支持progressTracker
                await this.#streamMergeWithFFmpeg(segments, streamState);
            } else {
                progressTracker.start(segments.length);
                const startIndex = isResumable || mapInfo ? 0 : 1;
                // 缓存合并 并发下载并缓存分片
                await this.#downloadAllSegments(segments.slice(startIndex));
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

        const { fileName: firstSegmentName, filePath: firstSegmentPath } = formatFileInfo(segments[0].index, config.tsDir);

        if (mapInfo) {
            this.#initFilePath = this.#mapPath;
        } else {
            this.#initFilePath = firstSegmentPath;
        }

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
                    filePath: this.#mapPath,
                    fileName: this.#mapFileName,
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
                    this.#initFilePath = firstSegmentPath;
                }
            }
        }

        const segmentPath = mapInfo ? this.#mapPath : firstSegmentPath;
        const segmentInfo = await parseSegmentInfo(segmentPath);
        this.#segmentInfo = segmentInfo;
        const { info: segmentInfoText } = segmentInfo;
        logger.log(`读取文件信息...\n${segmentInfoText}`, { colorful: true });
        if (!segmentInfoText) {
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
            await this.#handleDelAfterDone();
        } catch (err) {
            logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
        }
    }

    async #streamMergeWithFFmpeg(segments: Segment[], streamState: StreamMergeState | null): Promise<void> {
        const nextOffset = streamState?.nextOffset ?? 0;
        const previousParts = [...(streamState?.parts ?? [])];
        const useFMP4 = config.streamMergeFMP4;

        logger.log(`已启用流式合并模式${useFMP4 ? "(fMP4)" : ""}...\n`, { colorful: true });

        if (nextOffset === segments.length) {
            if (useFMP4) {
                await completeFMP4Merge(this.#fMP4FilePath, config.outputFile);
            } else {
                if (config.streamMergeForceMerge) {
                    await this.#concatMP4Parts(previousParts, config.outputFile);
                    logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });
                } else {
                    await this.#renameAllParts(previousParts);
                }
            }
            await this.#handleDelAfterDone();
            return;
        }
        if (useFMP4 && nextOffset > 0) {
            if (!checkTimescaleMap(this.#segmentInfo.timescaleMap)) {
                throw new Error("fMP4 视频流/音频流解析失败 无法断点续传");
            }
        }

        const isMapFile = this.#initFilePath === this.#mapPath;
        const startIndex = nextOffset === 0 && !isMapFile ? 1 : nextOffset;
        const streamProgress = { count: startIndex === 1 ? 1 : nextOffset };
        const currentPartIndex = previousParts.length;
        const tmpStreamPath = useFMP4
            ? formatFFmpegPath(this.#fMP4FilePath)
            : formatFFmpegPath(path.join(config.tempDir, `stream.tmp.part_${currentPartIndex}.mp4`));

        const currentDuration =
            useFMP4 && nextOffset > 0 ? segments.slice(0, nextOffset).reduce((sum, seg) => sum + seg.duration, 0) : 0;

        const { stdin, stdout, processExitPromise } = startStreamMerge(tmpStreamPath, useFMP4);

        let fileWriteStream: WriteStream | undefined = undefined;
        let stdoutPipelinePromise: Promise<void> = Promise.resolve();

        if (useFMP4) {
            // 'a' 追加模式; 'w' 覆盖模式
            fileWriteStream = createWriteStream(tmpStreamPath, { flags: nextOffset > 0 ? "a" : "w" });
            const streams =
                nextOffset > 0
                    ? [
                          stdout,
                          new MoofTransform(), // 剥离ftyp/moov头
                          new TimestampAdjuster(currentDuration, this.#segmentInfo.timescaleMap), // 修改时间戳偏移
                          fileWriteStream,
                      ]
                    : [stdout, fileWriteStream];
            stdoutPipelinePromise = pipeline(streams).catch((err) => {
                console.log("\n");
                logger.error(`🚨 [输出流崩溃] ${getErrorMessage(err)}`, { print: false });
                // 说明数据已污染，直接销毁数据
                stdin.destroy();
                throw err;
            });
        }

        try {
            const initialBuffers: Buffer[] = [];
            if (nextOffset === 0 || isMapFile) {
                if (this.#initFilePath) {
                    const initFileBuffer = await fs.readFile(this.#initFilePath);
                    initialBuffers.push(initFileBuffer);
                }
            }

            const stdinPipelinePromise = pipeSegmentsToStream({
                segments,
                targetStream: stdin,
                concurrency: config.concurrency,
                maxRetries: config.maxRetries,
                initialBuffers,
                progress: streamProgress,
                startIndex,
            })
                .then(() => {
                    if (stdin.writable) {
                        stdin.end();
                    }
                })
                .catch((err) => {
                    logger.error(`⚠️ [输入流崩溃] 分片下载失败: ${getErrorMessage(err)}`, { print: false });
                    // 如果输入流可写则保留数据，否则销毁
                    if (stdin.writable) {
                        stdin.end();
                    } else {
                        stdin.destroy();
                    }
                    throw err;
                });

            await Promise.all([stdinPipelinePromise, stdoutPipelinePromise]);
            await processExitPromise;
            if (useFMP4) {
                await completeFMP4Merge(tmpStreamPath, config.outputFile);
            } else {
                if (previousParts.length === 0) {
                    await fs.rename(tmpStreamPath, config.outputFile);
                } else {
                    const finalPartPath = path.join(config.tempDir, `part_${currentPartIndex}.mp4`);
                    await fs.rename(tmpStreamPath, finalPartPath);
                    const allParts = [...previousParts, finalPartPath];
                    await writeStreamMergeState(this.#stateFilePath, {
                        useFMP4,
                        nextOffset: segments.length,
                        totalSegments: segments.length,
                        parts: allParts,
                    });
                    if (config.streamMergeForceMerge) {
                        await this.#concatMP4Parts(allParts, config.outputFile);
                    } else {
                        await this.#renameAllParts(allParts);
                        await this.#handleDelAfterDone();
                        return;
                    }
                }
            }

            logger.log(`🎉 视频流式合并成功 : ${config.outputFile}`, { colorful: true });
            await this.#handleDelAfterDone();
        } catch (err) {
            const newOffset = streamProgress.count;

            try {
                await processExitPromise.catch(() => void 0);
                if (useFMP4) {
                    if (fileWriteStream?.destroyed === false) {
                        await new Promise((resolve) => fileWriteStream.end(resolve));
                    }
                    // 将单个临时文件路径保存进 state 结构
                    await writeStreamMergeState(this.#stateFilePath, {
                        useFMP4,
                        nextOffset: newOffset,
                        totalSegments: segments.length,
                        parts: [tmpStreamPath],
                    });
                } else {
                    const savedPartPath = path.join(config.tempDir, `part_${currentPartIndex}.mp4`);
                    await fs.rename(tmpStreamPath, savedPartPath);

                    await writeStreamMergeState(this.#stateFilePath, {
                        useFMP4,
                        nextOffset: newOffset,
                        totalSegments: segments.length,
                        parts: [...previousParts, savedPartPath],
                    });
                }
                logger.log("流式合并失败", { colorful: true });
            } catch (ffmpegErr) {
                stdin.destroy();
                if (useFMP4) {
                    await new Promise((resolve) => fileWriteStream!.end(resolve));
                } else {
                    await fs.unlink(tmpStreamPath).catch(() => void 0);
                }
                console.log("\n");
                logger.log(`流式合并致命错误，临时文件已删除": ${getErrorMessage(ffmpegErr)}`, { colorful: true });
            }

            throw err;
        }
    }
    async #concatMP4Parts(partPaths: string[], outputFile: string): Promise<void> {
        const concatContent = partPaths.map((p) => `file '${formatFFmpegPath(path.resolve(p))}'`).join("\n");
        const concatPath = path.join(config.tempDir, `concat_parts_${Date.now()}.txt`);
        await fs.writeFile(concatPath, concatContent, "utf-8");
        await concatMP4Parts(concatPath, outputFile);
    }

    async #renameAllParts(allParts: string[]): Promise<void> {
        for (const part of allParts) {
            const fileName = path.basename(part);
            const outputFile = path.join(config.workDir, `${config.saveName}.${fileName}`);
            await fs.rename(part, outputFile).catch(() => void 0);
            logger.log(`🎉 视频流式片段已写入 : ${outputFile}`, { colorful: true });
        }
        // 清理state文件，防止被重复触发
        await fs.unlink(this.#stateFilePath).catch(() => void 0);
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

    async #handleDelAfterDone(): Promise<void> {
        // 是否清理临时文件夹
        if (config.enableDelAfterDone) {
            // logger输出在临时文件夹，此时输出已无意义，因此先关闭日志流
            await logger.close();
            await fs.rm(config.tempDir, { recursive: true, force: true });
            logger.log("🧹 已清理全部临时缓存分片");
        }
    }
}
