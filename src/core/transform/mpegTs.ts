import { Transform, type TransformCallback } from "node:stream";

const TS_PACKET_SIZE = 188;
const MIN_SYNC_PACKETS = 5;
const STRONG_SYNC_PACKETS = 16;
const SEARCH_LIMIT = 64 * 1024;
const PSI_SCAN_PACKETS = 64;
const MAX_PSI_SECTION_SIZE = 1024;

/**
 * 为了验证位于搜索范围末尾的候选位置，还需要额外缓存后续 TS 包。
 */
const MAX_PROBE_BYTES = SEARCH_LIMIT + PSI_SCAN_PACKETS * TS_PACKET_SIZE;

interface TsPacketHeader {
    pid: number;
    payloadUnitStart: boolean;
    scrambled: boolean;
    hasPayload: boolean;
    payloadStart: number;
    packetEnd: number;
}

interface PatProgram {
    programNumber: number;
    pmtPid: number;
}

export interface MpegTsNormalizeResult {
    data: Buffer;
    offset: number;
    detected: boolean;
}

export interface MpegTsPrefixTransformOptions {
    /**
     * 完成判断后调用。
     *
     * 0：原始数据已经从 MPEG-TS 开始。
     * > 0：已删除对应长度的伪装前缀。
     * -1：没有检测到 MPEG-TS，数据保持不变。
     */
    onDetected?: (offset: number) => void | Promise<void>;

    /**
     * 图片文件头之后没有找到 MPEG-TS 时是否报错。
     */
    rejectImageWithoutTs?: boolean;
}

function parseTsHeader(data: Uint8Array, position: number): TsPacketHeader | undefined {
    const packetEnd = position + TS_PACKET_SIZE;

    if (packetEnd > data.length || data[position] !== 0x47) {
        return;
    }

    const byte1 = data[position + 1]!;
    const byte3 = data[position + 3]!;

    // transport_error_indicator 必须为 0。
    if ((byte1 & 0x80) !== 0) {
        return;
    }

    const adaptationFieldControl = (byte3 >> 4) & 0x03;

    // 00 为保留值。
    if (adaptationFieldControl === 0) {
        return;
    }

    let payloadStart = position + 4;

    if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
        const adaptationLength = data[position + 4]!;
        payloadStart = position + 5 + adaptationLength;

        if (payloadStart > packetEnd) {
            return;
        }
    }

    const hasPayload = (adaptationFieldControl === 1 || adaptationFieldControl === 3) && payloadStart < packetEnd;

    return {
        pid: ((byte1 & 0x1f) << 8) | data[position + 2]!,
        payloadUnitStart: (byte1 & 0x40) !== 0,
        scrambled: (byte3 & 0xc0) !== 0,
        hasPayload,
        payloadStart,
        packetEnd,
    };
}

function countConsecutivePackets(data: Uint8Array, offset: number, limit = STRONG_SYNC_PACKETS): number {
    let count = 0;

    for (; count < limit; count++) {
        const position = offset + count * TS_PACKET_SIZE;

        if (!parseTsHeader(data, position)) {
            break;
        }
    }

    return count;
}

/**
 * 收集指定 PID 的一个完整 PSI Section。
 *
 * 支持 PAT/PMT 跨越多个 TS 包。
 */
function readPsiSection(data: Uint8Array, tsOffset: number, pid: number): Uint8Array | undefined {
    const sectionBuffer = new Uint8Array(MAX_PSI_SECTION_SIZE);

    let collectedLength = 0;
    let expectedLength = 0;
    let collecting = false;

    for (let packetIndex = 0; packetIndex < PSI_SCAN_PACKETS; packetIndex++) {
        const packetPosition = tsOffset + packetIndex * TS_PACKET_SIZE;

        const header = parseTsHeader(data, packetPosition);

        if (!header) {
            break;
        }

        if (header.pid !== pid || !header.hasPayload || header.scrambled) {
            continue;
        }

        let position = header.payloadStart;

        if (header.payloadUnitStart) {
            const pointerField = data[position]!;

            position += 1 + pointerField;

            if (position > header.packetEnd) {
                continue;
            }

            collectedLength = 0;
            expectedLength = 0;
            collecting = true;
        } else if (!collecting) {
            continue;
        }

        while (position < header.packetEnd) {
            if (collectedLength >= sectionBuffer.length) {
                return;
            }

            sectionBuffer[collectedLength++] = data[position++]!;

            if (collectedLength === 3) {
                const sectionLength = ((sectionBuffer[1]! & 0x0f) << 8) | sectionBuffer[2]!;

                expectedLength = 3 + sectionLength;

                if (sectionLength < 4 || expectedLength > sectionBuffer.length) {
                    return;
                }
            }

            if (expectedLength !== 0 && collectedLength === expectedLength) {
                return sectionBuffer.slice(0, expectedLength);
            }
        }
    }
}

/**
 * MPEG-2 PSI 使用 CRC-32/MPEG-2。
 *
 * 将包含 CRC 字段的完整 Section 计算后，结果应为 0。
 */
function hasValidPsiCrc(section: Uint8Array): boolean {
    let crc = 0xffffffff;

    for (const byte of section) {
        crc = (crc ^ (byte << 24)) >>> 0;

        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
        }
    }

    return crc === 0;
}

function parsePat(section: Uint8Array | undefined): PatProgram[] | undefined {
    if (
        !section ||
        section.length < 12 ||
        section[0] !== 0x00 ||
        // section_syntax_indicator
        (section[1]! & 0x80) === 0 ||
        // current_next_indicator
        (section[5]! & 0x01) === 0 ||
        !hasValidPsiCrc(section)
    ) {
        return;
    }

    const programEnd = section.length - 4;

    if ((programEnd - 8) % 4 !== 0) {
        return;
    }

    const programs: PatProgram[] = [];

    for (let position = 8; position + 4 <= programEnd; position += 4) {
        const programNumber = (section[position]! << 8) | section[position + 1]!;

        // program_number === 0 指向 NIT，不是 PMT。
        if (programNumber === 0) {
            continue;
        }

        const pmtPid = ((section[position + 2]! & 0x1f) << 8) | section[position + 3]!;

        programs.push({
            programNumber,
            pmtPid,
        });
    }

    return programs.length > 0 ? programs : undefined;
}

function isValidPmt(section: Uint8Array | undefined, expectedProgramNumber: number): boolean {
    if (
        !section ||
        section.length < 16 ||
        section[0] !== 0x02 ||
        (section[1]! & 0x80) === 0 ||
        (section[5]! & 0x01) === 0 ||
        !hasValidPsiCrc(section)
    ) {
        return false;
    }

    const programNumber = (section[3]! << 8) | section[4]!;

    if (programNumber !== expectedProgramNumber) {
        return false;
    }

    const sectionEnd = section.length - 4;
    const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;

    let position = 12 + programInfoLength;

    if (position > sectionEnd) {
        return false;
    }

    let streamCount = 0;

    while (position < sectionEnd) {
        if (position + 5 > sectionEnd) {
            return false;
        }

        const esInfoLength = ((section[position + 3]! & 0x0f) << 8) | section[position + 4]!;

        position += 5 + esInfoLength;

        if (position > sectionEnd) {
            return false;
        }

        streamCount++;
    }

    return position === sectionEnd && streamCount > 0;
}

function hasValidPatAndPmt(data: Uint8Array, offset: number): boolean {
    const programs = parsePat(readPsiSection(data, offset, 0));

    if (!programs) {
        return false;
    }

    return programs.some(({ programNumber, pmtPid }) => isValidPmt(readPsiSection(data, offset, pmtPid), programNumber));
}

function startsWithBytes(data: Uint8Array, signature: readonly number[]): boolean {
    if (data.length < signature.length) {
        return false;
    }

    return signature.every((value, index) => data[index] === value);
}

export function hasImageFileSignature(data: Uint8Array): boolean {
    // PNG
    if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return true;
    }

    // JPEG
    if (startsWithBytes(data, [0xff, 0xd8, 0xff])) {
        return true;
    }

    // GIF87a / GIF89a
    if (startsWithBytes(data, [0x47, 0x49, 0x46, 0x38])) {
        return true;
    }

    // RIFF....WEBP
    return (
        data.length >= 12 &&
        startsWithBytes(data, [0x52, 0x49, 0x46, 0x46]) &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50
    );
}

/**
 * 在前 64 KiB 中查找可信的 MPEG-TS 起始位置。
 */
export function findMpegTsOffset(data: Uint8Array): number {
    const maxOffset = Math.min(SEARCH_LIMIT - 1, data.length - MIN_SYNC_PACKETS * TS_PACKET_SIZE);

    if (maxOffset < 0) {
        return -1;
    }

    const imagePrefix = hasImageFileSignature(data);

    for (let offset = 0; offset <= maxOffset; offset++) {
        if (data[offset] !== 0x47) {
            continue;
        }

        const packetCount = countConsecutivePackets(data, offset);

        if (packetCount < MIN_SYNC_PACKETS) {
            continue;
        }

        // PAT + PMT 是最高可信度。
        if (hasValidPatAndPmt(data, offset)) {
            return offset;
        }

        // 文件本身从 TS 开始，5 个连续包已经足够。
        if (offset === 0) {
            return 0;
        }

        // 已知图片伪装头后找到连续 TS 包。
        if (imagePrefix) {
            return offset;
        }

        // 未知前缀要求更多连续 TS 包。
        if (packetCount >= STRONG_SYNC_PACKETS) {
            return offset;
        }
    }

    return -1;
}

/**
 * 用于已经完整保存在内存中的分片。
 *
 * Buffer.subarray() 不复制底层数据。
 */
export function normalizeMpegTsBuffer(data: Buffer, rejectImageWithoutTs = true): MpegTsNormalizeResult {
    const offset = findMpegTsOffset(data);

    if (offset < 0 && rejectImageWithoutTs && hasImageFileSignature(data)) {
        throw new Error("分片具有图片文件头，但在前 64 KiB 内未找到有效 MPEG-TS");
    }

    return {
        data: offset > 0 ? data.subarray(offset) : data,
        offset,
        detected: offset >= 0,
    };
}

/**
 * 用于传统下载模式。
 *
 * 仅缓存探测窗口，完成判断后直接进入透传状态。
 */
export class MpegTsPrefixTransform extends Transform {
    readonly #onDetected: MpegTsPrefixTransformOptions["onDetected"];
    readonly #rejectImageWithoutTs: boolean;

    #chunks: Buffer[] = [];
    #bufferedLength = 0;
    #decided = false;

    constructor(options: MpegTsPrefixTransformOptions = {}) {
        super();

        this.#onDetected = options.onDetected;
        this.#rejectImageWithoutTs = options.rejectImageWithoutTs ?? true;
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        if (this.#decided) {
            callback(null, chunk);
            return;
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        const remainingProbeLength = MAX_PROBE_BYTES - this.#bufferedLength;

        const probeChunk = buffer.subarray(0, Math.max(0, remainingProbeLength));

        const remainder = buffer.subarray(probeChunk.length);

        if (probeChunk.length > 0) {
            this.#chunks.push(probeChunk);
            this.#bufferedLength += probeChunk.length;
        }

        if (this.#bufferedLength < MIN_SYNC_PACKETS * TS_PACKET_SIZE && remainder.length === 0) {
            callback();
            return;
        }

        const probe = Buffer.concat(this.#chunks, this.#bufferedLength);

        const offset = findMpegTsOffset(probe);

        if (offset >= 0 || this.#bufferedLength >= MAX_PROBE_BYTES) {
            this.#completeDetection(probe, remainder, offset, callback);
            return;
        }

        callback();
    }

    override _flush(callback: TransformCallback): void {
        if (this.#decided || this.#bufferedLength === 0) {
            callback();
            return;
        }

        const probe = Buffer.concat(this.#chunks, this.#bufferedLength);

        this.#completeDetection(probe, Buffer.alloc(0), findMpegTsOffset(probe), callback);
    }

    #completeDetection(probe: Buffer, remainder: Buffer, offset: number, callback: TransformCallback): void {
        if (offset < 0 && this.#rejectImageWithoutTs && hasImageFileSignature(probe)) {
            callback(new Error("分片具有图片文件头，但在前 64 KiB 内未找到有效 MPEG-TS"));
            return;
        }

        const output = offset > 0 ? probe.subarray(offset) : probe;

        Promise.resolve(this.#onDetected?.(offset)).then(() => {
            this.#decided = true;
            this.#chunks = [];
            this.#bufferedLength = 0;

            if (output.length > 0) {
                this.push(output);
            }

            if (remainder.length > 0) {
                this.push(remainder);
            }

            callback();
        }, callback);
    }
}
