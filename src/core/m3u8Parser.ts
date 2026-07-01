import { impit } from "#src/bin/worker.ts";
import { logger } from "#src/common/logger.ts";

export interface Segment {
    url: string;
    duration: number;
}

export interface ParsedM3u8 {
    segments: Segment[];
    totalDuration: number;
    mapInfo?: { url: string; byteRange?: string };
    rawMasterContent?: string;
    rawMediaContent?: string;
}

export class M3u8Parser {
    #url: string;

    constructor(url: string) {
        this.#url = url;
    }

    /**
     * 请求并解析 m3u8 文件
     */
    async parse(): Promise<ParsedM3u8> {
        // 请求媒体列表
        const { content, mediaUrl, rawMasterContent } = await this.#getM3U8(this.#url);
        // 解析媒体列表
        const mediaResult = this.#parseMedia(content, mediaUrl);
        return {
            ...mediaResult,
            rawMasterContent,
            rawMediaContent: content,
        };
    }

    async #getM3U8(url: string, depth = 0): Promise<{ content: string; mediaUrl: string; rawMasterContent?: string }> {
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
            const nextResult = await this.#getM3U8(mediaUrl, depth + 1);
            return {
                content: nextResult.content,
                mediaUrl: nextResult.mediaUrl,
                rawMasterContent: content,
            };
        }
        // 如果是媒体列表，直接返回内容
        return { content, mediaUrl: url };
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
        const lines = content.split("\n");
        const variants: { bandwidth: number; url: string }[] = [];
        let currentBandwidth = 0;

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith("#EXTM3U")) {
                continue;
            }

            if (line.startsWith("#EXT-X-STREAM-INF")) {
                const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            } else if (!line.startsWith("#")) {
                variants.push({ bandwidth: currentBandwidth, url: line });
                currentBandwidth = 0;
            }
        }

        if (variants.length === 0) {
            throw new Error("master.m3u8 未找到有效的清晰度分支");
        }
        variants.sort((a, b) => b.bandwidth - a.bandwidth);

        const bestVariant = variants[0];
        const masterBaseUrl = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
        const finalUrl = bestVariant.url.startsWith("http") ? bestVariant.url : new URL(bestVariant.url, masterBaseUrl).href;

        logger.log(`已选择最高清晰度 (${bestVariant.bandwidth} bps): ${finalUrl}`, { colorful: true });
        return finalUrl;
    }

    #parseMedia(content: string, mediaUrl: string): ParsedM3u8 {
        const lines = content.split("\n");
        const baseUrl = mediaUrl.substring(0, mediaUrl.lastIndexOf("/") + 1);
        const segments: Segment[] = [];
        let currentDuration = 0;
        let totalDuration = 0;
        let mapInfo: ParsedM3u8["mapInfo"];

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith("#EXTM3U")) {
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
                    // 解析 MAP 信息
                    else if (tag === "#EXT-X-MAP") {
                        const uriMatch = value.match(/URI=["']([^"']+)["']/);
                        if (uriMatch) {
                            if (mapInfo) {
                                throw new Error("media.m3u8 找到多个MAP文件");
                            }
                            const byteRangeMatch = value.match(/BYTERANGE=["']([^"']+)["']/);
                            mapInfo = {
                                url: this.#resolveUrl(uriMatch[1], baseUrl),
                                byteRange: byteRangeMatch?.[1],
                            };
                        }
                    }
                } else {
                    segments.push({
                        url: this.#resolveUrl(line, baseUrl),
                        duration: currentDuration,
                    });
                }
            } catch (err) {
                logger.error(`m3u8 行解析错误：${err}`);
            }
        }

        return {
            segments,
            totalDuration: Math.floor(totalDuration),
            mapInfo,
        };
    }

    #resolveUrl(pathOrUrl: string, baseUrl: string): string {
        return pathOrUrl.startsWith("http") ? pathOrUrl : new URL(pathOrUrl, baseUrl).href;
    }
}
