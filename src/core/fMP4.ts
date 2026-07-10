import { logger } from "#src/common/logger.ts";
import { type SegmentInfo } from "#src/core/ffmpeg.ts";
import fs from "node:fs/promises";
import { Transform } from "node:stream";

/**
 * fMP4 过滤器
 * * 过滤 ftyp/moov 并定位 moof
 */
export class MoofTransform extends Transform {
    #moofFound = false;
    #buffer = Buffer.alloc(0);
    // 防止损坏或恶意文件导致内存溢出
    readonly #MAX_BUFFER_SIZE = 20 * 1024 * 1024;

    _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        if (this.#moofFound) {
            this.push(chunk);
            return callback();
        }

        if (this.#buffer.length + chunk.length > this.#MAX_BUFFER_SIZE) {
            this.#cleanup();
            return callback(new Error("MoofTransform: Too large Buffer size"));
        }

        this.#buffer = Buffer.concat([this.#buffer, chunk]);

        // 循环解析 MP4 Box 结构
        while (this.#buffer.length >= 8) {
            // 读取前 4 字节的 Box Size
            const boxSize = this.#buffer.readUInt32BE(0);
            // 读取 4-8 字节的 Box Type
            const boxType = this.#buffer.toString("ascii", 4, 8);

            // 暂时不支持解析小于8字节的Box
            if (boxSize < 8) {
                this.#cleanup();
                return callback(new Error(`MoofTransform: Unsupported MP4 standard box size: ${boxSize}`));
            }

            if (boxSize > this.#MAX_BUFFER_SIZE) {
                this.#cleanup();
                return callback(new Error(`MoofTransform: Box size exceeds safety limit`));
            }

            // 精准匹配 moof
            if (boxType === "moof") {
                this.#moofFound = true;
                // 直接把当前位置（包含整个 moof 及其后面的所有内容）推向下游
                this.push(this.#buffer);
                this.#buffer = Buffer.alloc(0); // 清空暂存区
                return callback();
            }

            // 如果不是 moof (例如 ftyp, moov)，检查 Box 数据是否接收完整
            if (this.#buffer.length >= boxSize) {
                // 直接裁剪掉这个 Box，释放内存
                this.#buffer = this.#buffer.subarray(boxSize);
            } else {
                // 当前 Box 数据还不完整
                break;
            }
        }

        callback();
    }

    _flush(callback: () => void) {
        logger.log("MoofTransform 校验通过", { colorful: true });
        callback();
    }

    #cleanup() {
        this.#buffer = Buffer.alloc(0);
    }
}
export async function completeFMP4Merge(fMP4FilePath: string, outputFile: string): Promise<void> {
    // await removeTrailingMfra(fMP4FilePath);
    await fs.rename(fMP4FilePath, outputFile).catch(() => void 0);
}

export function checkTimescaleMap(timescaleMap: SegmentInfo["timescaleMap"]): boolean {
    return [...timescaleMap.values()].every((value) => value > 0);
}

/**
 * fMP4 音视频流时间戳修正器
 */
export class TimestampAdjuster extends Transform {
    readonly #currentDuration: number;
    readonly #timescaleMap: Map<number, number>;

    #state: "READ_HEADER" | "READ_MOOF" | "PASSTHROUGH" = "READ_HEADER";
    #buffer = Buffer.alloc(0);

    // 当前正在处理的 Top-level Box 信息
    #currentBoxType = "";
    #currentBoxSize = 0n;
    #headerSize = 8;
    #passthroughRemaining = 0n;

    // 防止损坏或恶意文件导致内存溢出
    readonly #MAX_METADATA_SIZE = 10n * 1024n * 1024n;

    /**
     * @param currentDuration 当前追加的起始时间偏移（秒）
     * @param timescaleMap 动态的 TrackID -> Timescale 映射表，例如：new Map([[1, 90000], [2, 44100]])
     */
    constructor(currentDuration: number, timescaleMap: SegmentInfo["timescaleMap"]) {
        super();
        this.#currentDuration = currentDuration;
        this.#timescaleMap = new Map(timescaleMap);
    }

    _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);

        let shouldProcess = true;
        while (shouldProcess) {
            if (this.#state === "READ_HEADER") {
                // 最少需要 8 字节来读取基础 Header (Size + Type)
                if (this.#buffer.length < 8) {
                    shouldProcess = false;
                    break;
                }

                const size = this.#buffer.readUInt32BE(0);
                const type = this.#buffer.toString("ascii", 4, 8);

                let headerSize = 8;
                let realSize = BigInt(size);

                // 处理 64 位的 Large Box
                if (size === 1) {
                    if (this.#buffer.length < 16) {
                        shouldProcess = false;
                        break;
                    }
                    realSize = this.#buffer.readBigUInt64BE(8);
                    headerSize = 16;
                }

                this.#currentBoxType = type;
                this.#currentBoxSize = realSize;
                this.#headerSize = headerSize;

                if (type === "moof") {
                    if (realSize > this.#MAX_METADATA_SIZE) {
                        return callback(new Error("TimestampAdjuster: 'moof' box size exceeds safety limit"));
                    }
                    this.#state = "READ_MOOF";
                } else {
                    // 非 moof 块 (如 mdat, sidx, free) 直接透传
                    this.#state = "PASSTHROUGH";
                    // 如果 size === 0，意味着该 Box 一直延伸到流的末尾
                    this.#passthroughRemaining = size === 0 ? 0n : realSize - BigInt(headerSize);

                    // 先把当前已经收到的 Header 发送出去
                    this.push(this.#buffer.subarray(0, headerSize));
                    this.#buffer = this.#buffer.subarray(headerSize);
                }
            }

            if (this.#state === "READ_MOOF") {
                const targetLength = Number(this.#currentBoxSize);
                if (this.#buffer.length < targetLength) {
                    // 数据不够，等待下一个 chunk
                    shouldProcess = false;
                    break;
                }

                // 截取完整的 moof 数据块进行结构化解析
                const moofBuf = this.#buffer.subarray(0, targetLength);
                const err = this.#adjustMoofStructure(moofBuf);
                if (err) {
                    this.#cleanup();
                    return callback(err);
                }

                this.push(moofBuf);
                this.#buffer = this.#buffer.subarray(targetLength);
                this.#state = "READ_HEADER";
            }

            if (this.#state === "PASSTHROUGH") {
                if (this.#buffer.length === 0) {
                    shouldProcess = false;
                    break;
                }

                // 如果是无界 Box (size=0)
                if (this.#currentBoxSize === 0n) {
                    this.push(this.#buffer);
                    this.#buffer = Buffer.alloc(0);
                    shouldProcess = false;
                    break;
                }

                const available = BigInt(this.#buffer.length);
                const toWrite = available > this.#passthroughRemaining ? this.#passthroughRemaining : available;

                this.push(this.#buffer.subarray(0, Number(toWrite)));
                this.#buffer = this.#buffer.subarray(Number(toWrite));
                this.#passthroughRemaining -= toWrite;

                if (this.#passthroughRemaining === 0n) {
                    this.#state = "READ_HEADER";
                }
            }
        }

        callback();
    }

    /**
     * 解析 moof -> traf -> tfhd/tfdt 拓扑树
     */
    #adjustMoofStructure(moofBuf: Buffer): Error | null {
        let pos = this.#headerSize; // 跳过 moof 自身的 header

        while (pos + 8 <= moofBuf.length) {
            const subSize = moofBuf.readUInt32BE(pos);
            const subType = moofBuf.toString("ascii", pos + 4, pos + 8);

            if (subSize < 8 || pos + subSize > moofBuf.length) {
                return new Error(`TimestampAdjuster: Malformed sub-box '${subType}' inside 'moof'`);
            }

            if (subType === "traf") {
                let trafPos = pos + 8;
                const trafEnd = pos + subSize;
                let currentTrackId: number | null = null;

                // 步进解析 traf 内部的子 Box
                while (trafPos + 8 <= trafEnd) {
                    const box2Size = moofBuf.readUInt32BE(trafPos);
                    const box2Type = moofBuf.toString("ascii", trafPos + 4, trafPos + 8);

                    if (box2Size < 8 || trafPos + box2Size > trafEnd) {
                        break;
                    }

                    if (box2Type === "tfhd") {
                        // tfhd 结构: 4字节size + 4字节type + 4字节flags + 4字节 track_ID
                        if (box2Size >= 16) {
                            currentTrackId = moofBuf.readUInt32BE(trafPos + 12);
                        }
                    } else if (box2Type === "tfdt") {
                        if (currentTrackId === null) {
                            return new Error("TimestampAdjuster: Malformed MP4, 'tfdt' box found before 'tfhd' in 'traf'");
                        }
                        const version = moofBuf[trafPos + 8]; // FullBox version

                        // 动态匹配：从 Map 中提取该 trackId 的真实 timescale，找不到则默认 90000 降级
                        const timescale = this.#timescaleMap.get(currentTrackId);
                        if (!timescale) {
                            return new Error(`TimestampAdjuster: Missing timescale, TrackId:${currentTrackId}`);
                        }
                        const offsetTicks = Math.round(this.#currentDuration * timescale);

                        if (version === 0 && box2Size >= 16) {
                            const originalVal = moofBuf.readUInt32BE(trafPos + 12);
                            const newVal = (originalVal + offsetTicks) % 0x100000000;
                            moofBuf.writeUInt32BE(newVal, trafPos + 12);
                        } else if (version === 1 && box2Size >= 20) {
                            const originalVal = moofBuf.readBigUInt64BE(trafPos + 12);
                            const newVal = originalVal + BigInt(offsetTicks);
                            moofBuf.writeBigUInt64BE(newVal, trafPos + 12);
                        } else {
                            return new Error(`TimestampAdjuster: Unsupported tfdt box version: ${version}`);
                        }
                    }
                    trafPos += box2Size;
                }
            }
            pos += subSize;
        }
        return null;
    }

    _flush(callback: (error?: Error | null) => void) {
        // 即使 #buffer 为空，如果透传计数器没归零（除非是 size=0 的无限块），也算作流异常截断
        const isPassthroughIncomplete =
            this.#state === "PASSTHROUGH" && this.#currentBoxSize !== 0n && this.#passthroughRemaining > 0n;
        if (this.#buffer.length > 0 || isPassthroughIncomplete) {
            this.#cleanup();
            return callback(new Error("TimestampAdjuster: Stream ended abruptly with incomplete MP4 box payload."));
        }
        logger.log("TimestampAdjuster 校验通过", { colorful: true });
        callback();
    }
    #cleanup() {
        this.#buffer = Buffer.alloc(0);
    }
}
