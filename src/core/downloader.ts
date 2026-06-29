import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { impit } from "#src/bin/worker.ts";
import pLimit from "p-limit";
import { logger } from "#src/common/logger.ts";
import type { DownloadRuntimeConfig, Segment } from "#src/common/types.ts";
import { formatBytes, formatTime, getErrorMessage } from "#src/common/utils.ts";
import { M3u8Parser } from "#src/core/m3u8Parser.ts";
import { mergeSegments, parseSegmentInfo } from "#src/core/ffmpeg.ts";
import { Readable } from "node:stream";

export class M3u8Downloader {
    #config: DownloadRuntimeConfig;
    #tempDir: string;
    #tsDir: string;
    #outputFile: string;
    #downloadedSet = new Set<string>();
    #failedSet = new Set<string>();
    #totalDuration = 0;
    #downloadedBytes = 0;
    #lastBytes = 0;
    #currentSpeed = 0;
    #totalCount = 0;
    #timer: NodeJS.Timeout | null = null;

    constructor(config: DownloadRuntimeConfig, { workDir, tempDir, tsDir }: Record<string, string>) {
        this.#config = config;
        this.#tempDir = tempDir;
        this.#tsDir = tsDir;
        this.#outputFile = path.join(workDir, `${config.saveName}.mp4`);
    }

    /**
     * 启动下载任务主流程
     */
    async start(): Promise<void> {
        try {
            logger.log(`文件名称：${this.#config.saveName}`);
            logger.log(`存储路径：${this.#config.workDir}`);
            logger.log(`开始解析：${this.#config.url}`, { colorful: true });

            const parser = new M3u8Parser(this.#config.url, this.#tempDir);
            const { segments, totalDuration } = await parser.parse();
            this.#totalDuration = totalDuration;
            this.#totalCount = segments.length;

            logger.log(`文件时长：${formatTime(this.#totalDuration)}`);
            // TODO 自定义分片范围
            logger.log(`总分片：${this.#totalCount}，已选择分片：${this.#totalCount}`);

            const isResumable = await this.#initResumableDownload();
            await this.#checkFirstSegment(segments, isResumable);

            this.#startProgressTimer();
            await this.#downloadSegments(segments, isResumable);

            this.#stopProgressTimer();
            await this.#handleDownloadCompletion();
        } catch (err) {
            if (this.#timer) {
                clearInterval(this.#timer);
            }
            logger.error(`\n💥 运行中断: ${getErrorMessage(err)}`);
            throw err;
        }
    }

    #startProgressTimer(): void {
        // 每秒刷新一次下载状态
        this.#timer = setInterval(() => {
            const deltaBytes = this.#downloadedBytes - this.#lastBytes;
            this.#currentSpeed = Math.max(0, deltaBytes);
            this.#lastBytes = this.#downloadedBytes;
            this.#printProgress();
        }, 1000);
    }

    #stopProgressTimer(): void {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
    }

    async #checkFirstSegment(segments: Segment[], isResumable: boolean): Promise<void> {
        logger.log(`开始下载文件`, { colorful: true }); //

        if (isResumable) {
            return;
        }

        logger.log(`下载首分片...`);
        const firstSegment = segments.shift();
        if (!firstSegment) {
            return;
        }

        const firstResult = await this.#downloadSegment(firstSegment.url, 0);
        if (firstResult !== "downloaded") {
            throw new Error("首分片下载失败");
        }

        const segmentInfo = await parseSegmentInfo(path.join(this.#tsDir, "000000.ts"));
        logger.log(`读取文件信息...\n${segmentInfo}`, { colorful: true });
    }

    async #downloadSegments(segments: Segment[], isResumable: boolean): Promise<void> {
        logger.log(`等待下载完成...`, { colorful: true });
        const limit = pLimit(this.#config.concurrency);

        const downloadTasks = segments.map(({ url: tsUrl }, i) => {
            // 根据是否断点续传对齐索引
            const index = isResumable ? i : i + 1;
            return limit(async () => {
                await this.#downloadSegment(tsUrl, index).catch((err) =>
                    logger.error(`\n分片 [${index}] 下载错误:${getErrorMessage(err)}`, { print: false })
                );
                this.#printProgress();
            });
        });

        await Promise.all(downloadTasks);
    }

    async #handleDownloadCompletion(): Promise<void> {
        const completedCount = this.#downloadedSet.size;
        const isFullyDownloaded = completedCount === this.#totalCount;

        console.log("\n");
        if (isFullyDownloaded) {
            if (!this.#config.noMerge) {
                logger.log("开始调用 ffmpeg 合并分片...\n", { log: false });
                await this.#mergeSegmentsWithFFmpeg();
            }
        } else {
            logger.error([...this.#failedSet].sort().join("\n"), { log: false });
            console.log("\n\n");
            logger.warn(`⚠️ 分片下载不完整：${completedCount}/${this.#totalCount}`);
            if (!this.#config.noMerge && this.#config.forceMerge) {
                logger.log("forceMerge == true ➔ 开始强制封装已下载分片...");
                await this.#mergeSegmentsWithFFmpeg();
            }
        }
    }

    /**
     * 初始化断点续传检测
     */
    async #initResumableDownload(): Promise<boolean> {
        const files = await fs.readdir(this.#tsDir);
        await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(this.#tsDir, file);

                if (file.endsWith(".ts")) {
                    this.#downloadedSet.add(file);
                    const { size } = await fs.stat(filePath);
                    this.#downloadedBytes += size;
                } else if (file.endsWith(".tmp")) {
                    // await fs.unlink(filePath);
                }
            })
        );

        this.#lastBytes = this.#downloadedBytes;
        const count = this.#downloadedSet.size;
        if (count > 0) {
            logger.log(`➔ 断点续传分片：${count}`);
            return true;
        } else {
            return false;
        }
    }

    /**
     * 下载单个 TS 分片
     */
    async #downloadSegment(tsUrl: string, index: number, retryCount = 0): Promise<"skipped" | "downloaded" | "failed"> {
        const fileName = `${String(index).padStart(6, "0")}.ts`;
        const filePath = path.join(this.#tsDir, fileName);
        const tmpFilePath = `${filePath}.tmp`;

        if (this.#downloadedSet.has(fileName)) {
            return "skipped";
        }

        let existingSize = 0;
        try {
            const stat = await fs.stat(tmpFilePath);
            existingSize = stat.size;
        } catch {
            // 文件不存在，说明是第一次下载
        }

        try {
            const headers: Record<string, string> = { ...this.#config.headers };
            if (existingSize > 0) {
                logger.log(`分片 [${index}] 尝试断点续传： ${existingSize} `, { print: false });
                headers["Range"] = `bytes=${existingSize}-`;
            }
            const response = await impit.fetch(tsUrl, {
                headers,
            });

            if (!response.ok) {
                const statusCode = response.status;
                const message = `分片 [${index}] 远程服务器返回错误 (${statusCode})`;
                if (statusCode === 404 || statusCode === 403) {
                    logger.error(message, { print: false });
                    this.#failedSet.add(message);
                    await fs.unlink(tmpFilePath).catch(() => void 0);
                    // 404、403 直接返回，跳过无意义重试
                    return "failed";
                }
                if (statusCode === 416) {
                    // 从响应头 Content-Range 中提取服务器文件的真实总大小
                    const contentRange = response.headers.get("content-range") || response.headers.get("Content-Range");
                    let serverSize = -1;
                    if (contentRange) {
                        const match = contentRange.match(/\/(\d+)$/);
                        if (match) {
                            serverSize = parseInt(match[1], 10);
                        }
                    }
                    logger.warn(`分片 [${index}] 远程服务器返回错误 (416)，本地缓存(${existingSize}) 服务器返回(${serverSize})`, {
                        print: false,
                    });

                    if (serverSize > 0 && existingSize === serverSize) {
                        logger.warn(`分片 [${index}] 本地缓存完整，完成下载`, { print: false });
                        await fs.rename(tmpFilePath, filePath);
                        this.#downloadedSet.add(fileName);
                        return "downloaded";
                    }

                    logger.warn(`分片 [${index}] 本地缓存与服务器返回不符，清空临时文件重新下载`, { print: false });
                    await fs.unlink(tmpFilePath).catch(() => void 0);
                    this.#downloadedBytes -= existingSize;
                    throw new Error(`Range 416 error, client auto-reset tmp file.`);
                }
                throw new Error(message);
            }

            if (!response.body) {
                throw new Error("Response body is empty");
            }

            // 判断服务器是否接受断点续传（206 Partial Content）
            const isPartial = response.status === 206;
            // 'a'→追加写入 'w'→覆盖写入
            const writeFlag = isPartial && existingSize > 0 ? "a" : "w";

            if (isPartial) {
                logger.log(`分片 [${index}] 开始断点续传`, { print: false });
            } else {
                if (existingSize > 0) {
                    logger.log(`分片 [${index}] 不支持断点续传`, { print: false });
                    // 回滚当前切片下载错加的字节数
                    this.#downloadedBytes -= existingSize;
                    existingSize = 0;
                }
            }

            const downloadStream = Readable.fromWeb(response.body);
            const fileStream = createWriteStream(tmpFilePath, { flags: writeFlag });

            downloadStream.on("data", (chunk: Buffer) => {
                this.#downloadedBytes += chunk.length;
            });

            await pipeline(downloadStream, fileStream);

            await fs.rename(tmpFilePath, filePath);
            this.#downloadedSet.add(fileName);
            return "downloaded";
        } catch (err) {
            logger.error(`分片 [${index}] 下载中断 (尝试第 ${retryCount + 1} 次): ${getErrorMessage(err)}`, { print: false });

            if (retryCount + 1 < this.#config.maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.#downloadSegment(tsUrl, index, retryCount + 1);
            } else {
                await fs.unlink(tmpFilePath).catch(() => void 0);
                const message = `分片 [${index}] 达到最大重试次数，下载失败`;
                logger.error(message, { print: false });
                this.#failedSet.add(message);
                return "failed";
            }
        }
    }

    /**
     * 拼接并使用 FFmpeg 转换为 MP4
     */
    async #mergeSegmentsWithFFmpeg(): Promise<void> {
        const listFilePath = path.join(this.#tempDir, "filelist.txt");
        const fileLines = [...this.#downloadedSet]
            .sort()
            .map((fileName) => `file '${path.resolve(this.#tsDir, fileName).replace(/\\/g, "/")}'`);

        await fs.writeFile(listFilePath, fileLines.join("\n"), "utf-8");

        try {
            // 💡 使用 Promise 包裹 spawn，实现异步等待
            await mergeSegments(listFilePath, this.#outputFile);
            logger.log(`🎉 视频封装合并成功: ${this.#outputFile}`);
            if (this.#config.enableDelAfterDone) {
                await logger.close();
                await fs.rm(this.#tempDir, { recursive: true, force: true });
                logger.log("🧹 已清理全部临时缓存分片");
            }
        } catch (err) {
            logger.error(`FFmpeg 合并失败: ${getErrorMessage(err)}`);
        }
    }

    /**
     * 控制台进度渲染
     */
    #printProgress(): void {
        const completedCount = this.#downloadedSet.size;
        if (completedCount === 0) {
            return;
        }
        const failedCount = this.#failedSet.size;
        const failedStr = failedCount ? `-${failedCount}` : "";
        const downloadedSizeStr = formatBytes(this.#downloadedBytes);
        const totalSize = (this.#downloadedBytes / completedCount) * this.#totalCount;
        const totalSizeStr = formatBytes(totalSize);
        const percent = ((completedCount / this.#totalCount) * 100).toFixed(2);
        const currentSpeedStr = `${formatBytes(this.#currentSpeed)}/s`;
        const timeStr =
            this.#currentSpeed > 0 ? ` @ ${formatTime((totalSize - this.#downloadedBytes) / this.#currentSpeed)}` : "";

        logger.print(
            `下载进度: ${completedCount}/${this.#totalCount}${failedStr} (${percent}%) -- ${downloadedSizeStr}/${totalSizeStr} (${currentSpeedStr}${timeStr})`
        );
    }
}
