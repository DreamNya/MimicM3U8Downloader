import { impit } from "#src/common/fetch.ts";
import { logger } from "#src/common/logger.ts";
import { getErrorMessage } from "#src/common/utils.ts";
import { type Segment } from "#src/core/m3u8Parser.ts";
import { type ImpitResponse } from "impit";
import crypto from "node:crypto";
import { Readable } from "node:stream";

// 密钥缓存，防止重复请求
const keyCache = new Map<string, Buffer>();

/**
 * 校验并缓存所有密钥
 * @throws {Error} 如果密钥下载失败或格式不合法，直接抛出异常以中断程序
 */
export async function preflightKeys(segments: Segment[]): Promise<void> {
    const keyUrls = new Set<string>();
    for (const seg of segments) {
        if (seg.keyInfo?.url) {
            keyUrls.add(seg.keyInfo.url);
        }
    }

    if (keyUrls.size === 0) {
        return;
    }

    logger.log(`🔒 检测到加密流，开始预检密钥 (共 ${keyUrls.size} 个)...`, { colorful: true });

    for (const url of keyUrls) {
        try {
            const response = await impit.fetch(url);
            if (!response.ok) {
                throw new Error(`远程服务器返回错误代码 (${response.status})`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const keyBuffer = Buffer.from(arrayBuffer);

            // 标准的 AES-128 Key 必须是 16 字节 (128 比特)
            if (keyBuffer.length !== 16) {
                throw new Error(`非标准的密钥长度！期待 16 字节，实际收到 ${keyBuffer.length} 字节`);
            }

            // 3. 校验通过，直接写入当前模块的内存缓存
            keyCache.set(url, keyBuffer);
            logger.log(`➔ 密钥下载成功并缓存: ${url}`, { print: false });
        } catch (err) {
            // 一旦出错立刻触发 Fail-Fast，抛出包装后的致命错误
            throw new Error(`💥 预检密钥失败! URL: ${url} | 原因: ${getErrorMessage(err)}`);
        }
    }

    logger.log(`预检密钥全部通过`, { colorful: true });
}

/**
 * 分片下载流包装器，如果存在AES-128加密则混合解密流
 */
export function createSegmentStream(body: ImpitResponse["body"], keyInfo?: Segment["keyInfo"]): Readable {
    const downloadStream = Readable.fromWeb(body);

    if (keyInfo?.url && keyInfo?.iv) {
        const keyBuffer = keyCache.get(keyInfo.url);
        if (!keyBuffer) {
            throw new Error(`🔒 密钥未被缓存，请确保预检成功! URL: ${keyInfo.url}`);
        }
        const decipher = crypto.createDecipheriv("aes-128-cbc", keyBuffer, keyInfo.iv);
        return downloadStream.pipe(decipher);
    }

    return downloadStream;
}
