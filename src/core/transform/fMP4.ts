import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

interface TrackEnd {
    timescale: number;
    decodeEnd: string;
}

export interface FMP4Checkpoint {
    byteLength: number;
    fragmentNumber: number;
    tracks: Record<string, TrackEnd>;
}

interface BoxHeader {
    size: number;
    type: string;
    headerSize: number;
}

function readBoxHeader(buffer: Buffer): BoxHeader | undefined {
    if (buffer.length < 8) return;
    const size32 = buffer.readUInt32BE(0);
    const headerSize = size32 === 1 ? 16 : 8;
    if (buffer.length < headerSize) return;
    const size = size32 === 1 ? Number(buffer.readBigUInt64BE(8)) : size32;
    if (!Number.isSafeInteger(size) || size < headerSize) {
        throw new Error("fMP4 Box 长度无效");
    }
    return { size, headerSize, type: buffer.toString("ascii", 4, 8) };
}

function* childBoxes(buffer: Buffer): Generator<{ type: string; data: Buffer }> {
    while (buffer.length) {
        const box = readBoxHeader(buffer);
        if (!box || box.size > buffer.length) {
            throw new Error("fMP4 子 Box 不完整");
        }
        yield { type: box.type, data: buffer.subarray(box.headerSize, box.size) };
        buffer = buffer.subarray(box.size);
    }
}

function trackRunDuration(run: Buffer, defaultDuration: number): bigint {
    const flags = run.readUInt32BE(0);
    const samples = run.readUInt32BE(4);
    let offset = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
    const hasDuration = (flags & 0x100) !== 0;
    const stride = (hasDuration ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);

    if (offset + samples * stride > run.length || (samples && !hasDuration && !defaultDuration)) {
        throw new Error("fMP4 缺少有效的样本时长");
    }
    if (!hasDuration) return BigInt(samples) * BigInt(defaultDuration);

    let duration = 0n;
    for (let i = 0; i < samples; i++, offset += stride) {
        duration += BigInt(run.readUInt32BE(offset));
    }
    return duration;
}

/** 读取 FFmpeg 输出的轨道时间轴，并在追加时按各轨道实际结束位置偏移。 */
export class FMP4Timeline extends Transform {
    readonly #previousTracks: FMP4Checkpoint["tracks"] | undefined;
    readonly #timescales = new Map<number, number>();
    readonly #defaultDurations = new Map<number, number>();
    readonly #offsets = new Map<number, bigint>();
    readonly #ends = new Map<number, bigint>();
    #pending: Buffer = Buffer.alloc(0);
    #passthroughBytes = 0;
    #fragmentNumber: number;

    constructor(previous?: FMP4Checkpoint) {
        super();
        this.#previousTracks = previous?.tracks;
        this.#fragmentNumber = previous?.fragmentNumber ?? 0;
    }

    checkpoint(byteLength: number): FMP4Checkpoint {
        if (!this.#ends.size) {
            throw new Error("fMP4 输出没有可用的媒体样本");
        }
        const tracks = { ...this.#previousTracks };
        for (const [trackId, end] of this.#ends) {
            tracks[trackId] = { timescale: this.#timescales.get(trackId)!, decodeEnd: end.toString() };
        }
        return { byteLength, fragmentNumber: this.#fragmentNumber, tracks };
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        let data = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
        try {
            while (data.length) {
                if (this.#passthroughBytes > 0) {
                    const consumed = Math.min(data.length, this.#passthroughBytes);
                    this.push(data.subarray(0, consumed));
                    data = data.subarray(consumed);
                    this.#passthroughBytes -= consumed;
                    continue;
                }

                const box = readBoxHeader(data);
                if (!box) break;
                const metadata = box.type === "moov" || box.type === "moof";
                const discard = this.#previousTracks && box.type !== "moof" && box.type !== "mdat";
                if (!metadata && !discard) {
                    this.#passthroughBytes = box.size;
                    continue;
                }
                if (box.size > 16 * 1024 * 1024) {
                    throw new Error(`fMP4 ${box.type} Box 过大`);
                }
                if (data.length < box.size) break;
                if (box.type === "moov") {
                    this.#readMovie(data.subarray(box.headerSize, box.size));
                } else if (box.type === "moof") {
                    this.#readFragment(data.subarray(box.headerSize, box.size));
                }
                if (!discard) this.push(data.subarray(0, box.size));
                data = data.subarray(box.size);
            }
            this.#pending = data;
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    override _flush(callback: TransformCallback): void {
        callback(this.#pending.length || this.#passthroughBytes ? new Error("fMP4 输出被截断") : undefined);
    }

    #readMovie(movie: Buffer): void {
        for (const { type, data } of childBoxes(movie)) {
            if (type === "mvex") {
                for (const box of childBoxes(data)) {
                    if (box.type === "trex") {
                        this.#defaultDurations.set(box.data.readUInt32BE(4), box.data.readUInt32BE(12));
                    }
                }
            }
            if (type !== "trak") continue;
            const boxes = [...childBoxes(data)];
            const header = boxes.find((box) => box.type === "tkhd")?.data;
            const media = boxes.find((box) => box.type === "mdia")?.data;
            const clock = media && [...childBoxes(media)].find((box) => box.type === "mdhd")?.data;
            if (!header || !clock) throw new Error("fMP4 缺少轨道时间刻度");
            const trackId = header.readUInt32BE(header[0] === 1 ? 20 : 12);
            const timescale = clock.readUInt32BE(clock[0] === 1 ? 20 : 12);
            if (!timescale || (this.#previousTracks && this.#previousTracks[trackId]?.timescale !== timescale)) {
                throw new Error(`fMP4 轨道 ${trackId} 的时间刻度无法与已有文件匹配`);
            }
            this.#timescales.set(trackId, timescale);
        }
    }

    #readFragment(fragment: Buffer): void {
        const fragmentBoxes = [...childBoxes(fragment)];
        const sequence = fragmentBoxes.find((box) => box.type === "mfhd")?.data;
        if (!sequence) throw new Error("fMP4 缺少片段序号");
        if (this.#previousTracks) sequence.writeUInt32BE(this.#fragmentNumber + 1, 4);
        this.#fragmentNumber = Math.max(this.#fragmentNumber, sequence.readUInt32BE(4));

        for (const { type, data } of fragmentBoxes) {
            if (type !== "traf") continue;
            const boxes = [...childBoxes(data)];
            const header = boxes.find((box) => box.type === "tfhd")?.data;
            const timestamp = boxes.find((box) => box.type === "tfdt")?.data;
            if (!header || !timestamp || timestamp[0] > 1) throw new Error("fMP4 缺少有效的轨道起始时间");

            const flags = header.readUInt32BE(0);
            const trackId = header.readUInt32BE(4);
            if (!this.#timescales.has(trackId)) throw new Error(`fMP4 缺少轨道 ${trackId} 的初始化信息`);
            const defaultDurationOffset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
            const defaultDuration =
                flags & 8 ? header.readUInt32BE(defaultDurationOffset) : (this.#defaultDurations.get(trackId) ?? 0);
            let duration = 0n;
            for (const box of boxes) {
                if (box.type === "trun") duration += trackRunDuration(box.data, defaultDuration);
            }
            if (duration === 0n) continue;

            const base = timestamp[0] === 1 ? timestamp.readBigUInt64BE(4) : BigInt(timestamp.readUInt32BE(4));
            let offset = this.#offsets.get(trackId);
            if (offset === undefined) {
                const previous = this.#previousTracks?.[trackId];
                offset = previous ? BigInt(previous.decodeEnd) - base : 0n;
                this.#offsets.set(trackId, offset);
            }
            const start = base + offset;
            const priorEnd = this.#ends.get(trackId);
            if (priorEnd !== undefined && start < priorEnd) throw new Error(`fMP4 轨道 ${trackId} 的解码时间重叠`);
            if (offset !== 0n) {
                if (timestamp[0] === 1) timestamp.writeBigUInt64BE(start, 4);
                else timestamp.writeUInt32BE(Number(start), 4);
            }
            this.#ends.set(trackId, start + duration);
        }
    }
}

/** 从旧版断点的输出恢复轨道时间轴。 */
export async function readFMP4Checkpoint(filePath: string): Promise<FMP4Checkpoint> {
    const timeline = new FMP4Timeline();
    const discard = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    await pipeline(createReadStream(filePath), timeline, discard);
    return timeline.checkpoint((await stat(filePath)).size);
}
