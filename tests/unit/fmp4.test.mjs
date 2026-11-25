import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { FMP4Timeline } from "#src/core/transform/fMP4.ts";

function words(...values) {
    const data = Buffer.alloc(values.length * 4);
    for (const [index, value] of values.entries()) {
        data.writeUInt32BE(value, index * 4);
    }
    return data;
}

function box(type, ...payload) {
    const body = Buffer.concat(payload);
    return Buffer.concat([words(body.length + 8), Buffer.from(type, "ascii"), body]);
}

function track(id, timescale) {
    return box("trak", box("tkhd", words(0, 0, 0, id)), box("mdia", box("mdhd", words(0, 0, 0, timescale))));
}

function movie(videoTimescale = 90_000) {
    const audioDefaults = box("trex", words(0, 2, 1, 1024, 0, 0));
    return box("moov", track(1, videoTimescale), track(2, 48_000), box("mvex", audioDefaults));
}

function trackFragment(id, decodeTime, run) {
    const header = box("tfhd", words(0, id));
    const timestamp =
        typeof decodeTime === "bigint"
            ? words(0x01000000, Number(decodeTime >> 32n), Number(decodeTime & 0xffff_ffffn))
            : words(0, decodeTime);
    return box("traf", header, box("tfdt", timestamp), box("trun", run));
}

function fragment(sequence, ...tracks) {
    return box("moof", box("mfhd", words(0, sequence)), ...tracks);
}

async function transform(timeline, input) {
    // Seven-byte chunks split MP4 box headers, metadata and media payloads.
    const chunks = Array.from({ length: Math.ceil(input.length / 7) }, (_, i) => input.subarray(i * 7, (i + 1) * 7));
    return pipeline(Readable.from(chunks), timeline, async (stream) => Buffer.concat(await Array.fromAsync(stream)));
}

const previous = {
    byteLength: 512,
    fragmentNumber: 7,
    tracks: {
        1: { timescale: 90_000, decodeEnd: "9100" },
        2: { timescale: 48_000, decodeEnd: "4294969344" },
    },
};

test("fMP4 reads split boxes and records each track in its own timescale", async () => {
    const video = trackFragment(1, 100, words(0x100, 2, 3000, 6000));
    const audio = trackFragment(2, 0x1_0000_0000n, words(0, 2));
    const input = Buffer.concat([movie(), fragment(7, video, audio), box("mdat", Buffer.from("payload"))]);
    const timeline = new FMP4Timeline();

    assert.deepEqual(await transform(timeline, input), input);
    assert.deepEqual(timeline.checkpoint(input.length), { ...previous, byteLength: input.length });
});

test("fMP4 rewrites fragment sequence and version 0 and 1 decode times on resume", async () => {
    const videoRun = words(0x100, 1, 3000);
    const audioRun = words(0, 1);
    const mediaData = box("mdat", Buffer.from("payload"));
    const input = Buffer.concat([
        movie(),
        fragment(1, trackFragment(1, 50, videoRun), trackFragment(2, 16n, audioRun)),
        mediaData,
    ]);
    const expectedFragment = fragment(8, trackFragment(1, 9100, videoRun), trackFragment(2, 4294969344n, audioRun));
    const timeline = new FMP4Timeline(previous);

    const output = await transform(timeline, input);
    assert.deepEqual(output, Buffer.concat([expectedFragment, mediaData]));
    const byteLength = previous.byteLength + output.length;
    assert.deepEqual(timeline.checkpoint(byteLength), {
        byteLength,
        fragmentNumber: 8,
        tracks: {
            1: { timescale: 90_000, decodeEnd: "12100" },
            2: { timescale: 48_000, decodeEnd: "4294970368" },
        },
    });
});

test("fMP4 rejects a track timescale change on resume", async () => {
    await assert.rejects(transform(new FMP4Timeline(previous), movie(1000)), /轨道 1 的时间刻度无法与已有文件匹配/);
});

test("fMP4 reports a truncated media data box at the end of the stream", async () => {
    const input = box("mdat", Buffer.from("payload")).subarray(0, -1);
    await assert.rejects(transform(new FMP4Timeline(), input), /fMP4 输出被截断/);
});

test("fMP4 rejects a child box that exceeds the enclosing metadata box", async () => {
    const input = box("moov", words(20), Buffer.from("trak"));
    await assert.rejects(transform(new FMP4Timeline(), input), /fMP4 子 Box 不完整/);
});
