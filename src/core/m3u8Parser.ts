import fs from "node:fs/promises";
import type { Segment } from "#src/common/types.ts";
import { logger } from "#src/common/logger.ts";
import { impit } from "#src/bin/worker.ts";

export class M3u8Parser {
    #url: string;
    #tempDir: string;

    constructor(url: string, tempDir: string) {
        this.#url = url;
        this.#tempDir = tempDir;
    }

    /**
     * 请求并解析 m3u8 文件
     */
    async parse(): Promise<{ segments: Segment[]; totalDuration: number }> {
        // 请求媒体列表
        const { content, mediaUrl } = await this.#getM3U8(this.#url);
        // 解析媒体列表
        return this.#parseMedia(content, mediaUrl);
    }

    async #getM3U8(url: string, depth = 0): Promise<{ content: string; mediaUrl: string }> {
        if (depth > 3) {
            throw new Error("m3u8 嵌套层级过深或存在循环重定向");
        }

        const response = await impit.fetch(url);
        if (!response.ok) {
            throw new Error(`m3u8 远程服务器返回错误 (${response.status})`);
        }
        const content = await response.text();
        const isMaster = this.#isMasterPlaylist(content);

        if (isMaster) {
            const mediaUrl = this.#parseMaster(content, url);
            // 如果是大师列表，则重新请求媒体列表
            return this.#getM3U8(mediaUrl, depth + 1);
        } else {
            // 如果是媒体列表，直接返回内容
            return { content, mediaUrl: url };
        }
    }

    /**
     * 判断是否为大师列表 (Master Playlist)
     */
    #isMasterPlaylist(content: string): boolean {
        return content.includes("#EXT-X-STREAM-INF");
    }

    /**
     * 解析大师列表，提取最高清晰度的媒体列表
     */
    #parseMaster(content: string, baseUrl: string): string {
        fs.writeFile(`${this.#tempDir}/master.m3u8`, content).catch(() => void 0);

        const lines = content.split("\n");
        const variants: { bandwidth: number; url: string }[] = [];
        let currentBandwidth = 0;

        for (let line of lines) {
            line = line.trim();
            if (!line) {
                continue;
            }

            if (line.startsWith("#EXT-X-STREAM-INF")) {
                const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            } else if (!line.startsWith("#")) {
                variants.push({
                    bandwidth: currentBandwidth,
                    url: line,
                });
                currentBandwidth = 0; // 提取完毕后重置
            }
        }

        if (variants.length === 0) {
            throw new Error("Master m3u8 文件中未找到任何有效的清晰度分支 (Variant Stream)");
        }

        // 按带宽从大到小排序，筛选最高清晰度
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        const bestVariant = variants[0];

        const masterBaseUrl = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
        const finalUrl = bestVariant.url.startsWith("http") ? bestVariant.url : new URL(bestVariant.url, masterBaseUrl).href;

        logger.log(`已自动选择最高清晰度 (${bestVariant.bandwidth} bps): ${finalUrl}`, { colorful: true });
        logger.log("重新解析m3u8...", { colorful: true });

        return finalUrl;
    }

    /**
     * 解析包含 TS 分片的媒体列表
     */
    #parseMedia(content: string, mediaUrl: string): { segments: Segment[]; totalDuration: number } {
        fs.writeFile(`${this.#tempDir}/video.m3u8`, content).catch(() => void 0);

        const lines = content.split("\n");
        const baseUrl = mediaUrl.substring(0, mediaUrl.lastIndexOf("/") + 1);
        const segments: Segment[] = [];
        let currentDuration = 0;
        let totalDuration = 0;

        for (let line of lines) {
            line = line.trim();
            if (!line) {
                continue;
            }

            try {
                if (line.startsWith("#")) {
                    const splitIndex = line.indexOf(":");
                    const tag = splitIndex === -1 ? line : line.slice(0, splitIndex);
                    const value = splitIndex === -1 ? "" : line.slice(splitIndex + 1);

                    if (tag === "#EXTINF") {
                        const [duration] = value.split(",");
                        currentDuration = Number(duration) || 0;
                        totalDuration += currentDuration;
                    }
                } else {
                    const fullUrl = line.startsWith("http") ? line : new URL(line, baseUrl).href;
                    segments.push({
                        url: fullUrl,
                        duration: currentDuration,
                    });
                }
            } catch (err) {
                logger.error(`m3u8 行解析错误：${err}`);
                continue;
            }
        }

        return {
            segments,
            totalDuration: Math.floor(totalDuration),
        };
    }
}
