import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { MpegTsPrefixTransform, normalizeMpegTsBuffer } from "#src/core/transform/mpegTs.ts";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const packetSize = 188;

function nullPackets(count) {
    const payload = Buffer.alloc(count * packetSize, 0xff);
    const header = Buffer.from([0x47, 0x1f, 0xff, 0x10]);
    for (let offset = 0; offset < payload.length; offset += packetSize) {
        header.copy(payload, offset);
    }
    return payload;
}

function transform(chunks, onDetected) {
    return pipeline(Readable.from(chunks), new MpegTsPrefixTransform({ onDetected }), async (stream) =>
        Buffer.concat(await Array.fromAsync(stream))
    );
}

test("MPEG-TS detection preserves packets when they start at byte zero", () => {
    const data = nullPackets(5);
    assert.deepEqual(normalizeMpegTsBuffer(data), { data, offset: 0, detected: true });
});

test("MPEG-TS detection does not remove a prefix on the strength of five null packets alone", () => {
    const data = Buffer.concat([Buffer.from("prefix"), nullPackets(5)]);
    assert.deepEqual(normalizeMpegTsBuffer(data), { data, offset: -1, detected: false });
});

test("MPEG-TS detection ignores sync bytes with invalid packet headers", () => {
    const data = Buffer.alloc(16 * packetSize);
    for (let offset = 0; offset < data.length; offset += packetSize) {
        data[offset] = 0x47;
    }
    assert.deepEqual(normalizeMpegTsBuffer(data), { data, offset: -1, detected: false });
});

test("MPEG-TS detection and streaming both strip a PNG prefix across input chunks", async () => {
    const packets = nullPackets(6);
    const input = Buffer.concat([pngSignature, packets]);
    assert.deepEqual(normalizeMpegTsBuffer(input), { data: packets, offset: pngSignature.length, detected: true });

    const offsets = [];
    const chunks = [input.subarray(0, 3), input.subarray(3, 11), input.subarray(11, 950), input.subarray(950)];
    assert.deepEqual(await transform(chunks, (offset) => offsets.push(offset)), packets);
    assert.deepEqual(offsets, [pngSignature.length]);
});

test("MPEG-TS detection rejects an image without media packets in both modes", async () => {
    const data = Buffer.concat([pngSignature, Buffer.from("image data")]);
    const error = /具有图片文件头.*未找到有效 MPEG-TS/;
    assert.throws(() => normalizeMpegTsBuffer(data), error);
    await assert.rejects(transform([data]), error);
});
