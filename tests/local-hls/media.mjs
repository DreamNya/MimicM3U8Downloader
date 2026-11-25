import assert from "node:assert/strict";
import { run } from "./fixtures.mjs";

function ffmpegInput(video) {
    return Buffer.isBuffer(video) ? ["pipe:0", video] : [video, undefined];
}

export async function hashFrames(video, indexes) {
    const [input, buffer] = ffmpegInput(video);
    // -skip_frame nokey makes n the keyframe index, and framehash hashes decoded pixels.
    const select = indexes.map((index) => `eq(n,${index})`).join("+");
    const output = await run(
        "ffmpeg",
        [
            "-v",
            "error",
            "-xerror",
            "-threads",
            "1",
            "-skip_frame",
            "nokey",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-vf",
            `select='${select}'`,
            "-fps_mode",
            "passthrough",
            "-frames:v",
            String(indexes.length),
            "-f",
            "framehash",
            "pipe:1",
        ],
        buffer
    );
    const hashes = output
        .toString()
        .split(/\r?\n/)
        .filter((line) => /^\d+,/.test(line));
    assert.equal(hashes.length, indexes.length, "Unexpected number of decoded keyframes");
    return hashes.map((line) => line.split(",").at(-1).trim());
}

export async function checkTimeline(video, expectedDuration, { maxAudioInterval = 0.045, durationTolerance = 0.15 } = {}) {
    const [input, buffer] = ffmpegInput(video);
    const output = await run(
        "ffprobe",
        ["-v", "error", "-show_packets", "-show_entries", "packet=codec_type,dts_time,duration_time", "-of", "json", input],
        buffer
    );
    const { packets } = JSON.parse(output);
    const durations = {};
    for (const [type, maxInterval] of [
        ["video", 0.041],
        ["audio", maxAudioInterval],
    ]) {
        const track = packets.filter((packet) => packet.codec_type === type);
        assert.ok(track.length, `Missing ${type} packets`);
        const timestamps = track.map((packet) => Number(packet.dts_time));
        assert.ok(timestamps.every(Number.isFinite), `Missing ${type} DTS`);
        const duration = timestamps.at(-1) + Number(track.at(-1).duration_time) - timestamps[0];
        assert.ok(Number.isFinite(duration), `Missing ${type} duration`);
        if (expectedDuration !== undefined) {
            for (let i = 1; i < timestamps.length; i++) {
                const interval = timestamps[i] - timestamps[i - 1];
                assert.ok(interval > 0 && interval <= maxInterval, `${type} DTS gap at ${timestamps[i]}: ${interval}s`);
            }
            assert.ok(
                Math.abs(duration - expectedDuration) <= durationTolerance,
                `${type} duration ${duration}s, expected ${expectedDuration}s`
            );
        }
        durations[type] = duration;
    }
    return durations;
}
