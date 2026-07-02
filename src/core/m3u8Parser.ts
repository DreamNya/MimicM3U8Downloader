import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";

export interface Segment {
    url: string;
    duration: number;
    keyInfo?: {
        method: "AES-128";
        url?: string;
        iv?: Buffer;
    };
}

export interface ParsedM3u8 {
    segments: Segment[];
    totalDuration: number;
    mapInfo?: { url: string; byteRange?: string; keyInfo: Segment["keyInfo"] };
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

        let mediaSequence = 0;
        let currentKeyInfo: { method: string; url?: string; rawIv?: string } | undefined = undefined;

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
                    } else if (tag === "#EXT-X-KEY") {
                        const methodMatch = value.match(/METHOD=([^,]+)/);
                        const method = methodMatch ? methodMatch[1].trim() : "NONE";

                        if (method === "AES-128") {
                            const uriMatch = value.match(/URI=["']([^"']+)["']/);
                            if (uriMatch) {
                                const ivMatch = value.match(/IV=0x([0-9a-fA-F]+)/);
                                currentKeyInfo = {
                                    method: "AES-128",
                                    url: this.#resolveUrl(uriMatch[1], baseUrl),
                                    rawIv: ivMatch?.[1],
                                };
                            }
                        } else {
                            logger.warn(`m3u8 解析到不支持的加密方式：${method}`);
                            currentKeyInfo = undefined;
                        }
                    }
                    // 解析 MAP 信息
                    else if (tag === "#EXT-X-MAP") {
                        const uriMatch = value.match(/URI=["']([^"']+)["']/);
                        if (uriMatch) {
                            if (mapInfo) {
                                throw new Error("media.m3u8 找到多个MAP文件");
                            }
                            const byteRangeMatch = value.match(/BYTERANGE=["']([^"']+)["']/);
                            let mapKeyInfo: Segment["keyInfo"] = undefined;
                            if (currentKeyInfo?.method === "AES-128") {
                                mapKeyInfo = {
                                    method: "AES-128",
                                    url: currentKeyInfo.url,
                                    // 根据规范，加密 MAP 必须有显式 IV，如缺省则初始化 16 字节全零
                                    iv: currentKeyInfo.rawIv
                                        ? Buffer.from(currentKeyInfo.rawIv.padStart(32, "0"), "hex")
                                        : Buffer.alloc(16),
                                };
                            }
                            mapInfo = {
                                url: this.#resolveUrl(uriMatch[1], baseUrl),
                                byteRange: byteRangeMatch?.[1],
                                keyInfo: mapKeyInfo,
                            };
                        }
                    }
                } else {
                    let segmentKeyInfo: Segment["keyInfo"] = undefined;
                    if (currentKeyInfo?.method === "AES-128") {
                        let ivBuffer: Buffer;
                        if (currentKeyInfo.rawIv) {
                            // 如果显式指定了 IV，将其转为 16 字节的 Buffer
                            ivBuffer = Buffer.from(currentKeyInfo.rawIv.padStart(32, "0"), "hex");
                        } else {
                            // 如果未指定 IV，标准 HLS 规定使用大端序的媒体序列号（16字节，前面补零）
                            ivBuffer = Buffer.alloc(16);
                            ivBuffer.writeUInt32BE(mediaSequence, 12);
                        }

                        segmentKeyInfo = {
                            method: "AES-128",
                            url: currentKeyInfo.url,
                            iv: ivBuffer,
                        };
                    }

                    segments.push({
                        url: this.#resolveUrl(line, baseUrl),
                        duration: currentDuration,
                        keyInfo: segmentKeyInfo,
                    });

                    // 每一个分片过后，序列号自增
                    mediaSequence++;
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
