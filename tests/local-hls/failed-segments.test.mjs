import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getFixtures, removeRun, run, serveFixtures } from "./fixtures.mjs";
import { checkTimeline } from "./media.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const requests = [];
const missing = new Set();
let root;
let server;
let heldRequest;

before(async () => {
    const { files } = await getFixtures(12, "disk");
    root = await mkdtemp(path.join(os.tmpdir(), "mimic-hls-test-"));
    server = await serveFixtures(files, (pathname) => {
        requests.push(pathname);
        if (heldRequest?.pathname === pathname) {
            heldRequest.arrived();
            return heldRequest.release;
        }
        return missing.has(pathname) ? 404 : undefined;
    });
});

after(async () => {
    try {
        await server?.close();
    } finally {
        if (root) {
            await removeRun(root, os.tmpdir());
        }
    }
});

function failSegments(...paths) {
    requests.length = 0;
    missing.clear();
    for (const segment of paths) missing.add(segment);
}

function startDownload(name, format, options, nodeArgs = []) {
    return exec(
        process.execPath,
        [
            ...nodeArgs,
            "src/bin/worker.ts",
            "--url",
            `${server.origin}/${format}/media.m3u8`,
            "--saveName",
            name,
            "--workDir",
            root,
            "--pauseAfterDone",
            "false",
            "--proxyUrl",
            "",
            "--headers",
            "{}",
            "--streamMerge",
            "false",
            "--streamMergeFMP4",
            "false",
            "--streamMergeForceMerge",
            "false",
            "--range",
            "",
            "--noMerge",
            "false",
            "--forceMerge",
            "false",
            "--enableDelAfterDone",
            "false",
            "--debug",
            "false",
            "--skipFailedSegments",
            "true",
            "--concurrency",
            "1",
            "--maxRetries",
            "1",
            ...options,
        ],
        { cwd: repo, timeout: 20_000, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" } }
    );
}

function download(name, format, ...options) {
    return startDownload(name, format, options);
}

async function assertContinuousFile(name, expectedSeconds) {
    const file = path.join(root, `${name}.mp4`);
    await checkTimeline(file, expectedSeconds, { maxAudioInterval: 0.03, durationTolerance: 0.1 });
    await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
}

test("cached downloads use the selected range as the percentage denominator", async () => {
    failSegments("/ts/segment-1.ts");
    await assert.rejects(
        download("below-limit", "ts", "--range", "0-4", "--maxFailedSegments", "19%", "--forceMerge", "true"),
        (err) => err.code === 1 && /上限/.test(err.stderr + err.stdout)
    );
    assert.ok(!requests.includes("/ts/segment-2.ts"));
    await assert.rejects(stat(path.join(root, "below-limit.mp4")), { code: "ENOENT" });

    failSegments("/ts/segment-1.ts");
    const { stdout, stderr } = await download("at-limit", "ts", "--range", "0-4", "--maxFailedSegments", "20%");
    assert.match(stdout, /下载进度: 4\/5-1 \(80\.00%\)/);
    assert.match(stderr, /合并时跳过 1 个下载失败的分片，编号为 1\r?\n/);
    assert.ok(requests.includes("/ts/segment-4.ts"));
    assert.ok(!requests.includes("/ts/segment-5.ts"));
    await stat(path.join(root, "at-limit.mp4"));
});

test("streaming MP4 accepts an omitted limit and keeps downloading", async () => {
    failSegments("/ts/segment-2.ts", "/ts/segment-3.ts");
    const { stdout, stderr } = await download("stream-mp4", "ts", "--streamMerge", "true");
    assert.match(stdout, /下载进度: 4\/6-2 \(66\.67%\) -- ([^/\r\n]+)\/\1 \(/);
    assert.doesNotMatch(stdout + stderr, /Input #0|frame=\s*\d+/);
    assert.deepEqual(stderr.match(/分片 \[\d+\] 下载失败(?=\r?$)/gm), ["分片 [2] 下载失败", "分片 [3] 下载失败"]);
    assert.doesNotMatch(stderr, /流式合并中跳过/);
    assert.deepEqual(stderr.match(/本轮流式合并跳过[^\r\n]*/g), ["本轮流式合并跳过 2 个下载失败的分片，编号为 2、3"]);
    assert.ok(requests.includes("/ts/segment-5.ts"));
    await stat(path.join(root, "stream-mp4.mp4"));
    const logDir = path.join(root, "stream-mp4");
    const logFile = (await readdir(logDir)).find((name) => name.endsWith(".log"));
    assert.ok(logFile);
    assert.match(await readFile(path.join(logDir, logFile), "utf8"), /FFmpeg 封装日志/);
});

test("streaming fMP4 compresses a gap and resumes from the recorded media position", async () => {
    failSegments("/ts/segment-2.ts", "/ts/segment-4.ts");
    const flags = ["--streamMerge", "true", "--streamMergeFMP4", "true", "--maxFailedSegments", "1"];
    await assert.rejects(
        download("stream-resume", "ts", ...flags),
        (err) => err.code === 1 && /上限/.test(err.stderr + err.stdout)
    );
    const state = JSON.parse(await readFile(path.join(root, "stream-resume", "stream_merge_state.json"), "utf8"));
    assert.equal(state.nextOffset, 4);
    assert.equal(state.skippedCount, 1);
    assert.equal(Object.keys(state.fmp4.tracks).length, 2);
    await appendFile(state.parts[0], "partial uncommitted write");

    failSegments("/ts/segment-2.ts", "/ts/segment-5.ts");
    await assert.rejects(
        download("stream-resume", "ts", ...flags),
        (err) => err.code === 1 && /上限/.test(err.stderr + err.stdout)
    );
    assert.ok(!requests.includes("/ts/segment-2.ts"));
    assert.ok(!requests.includes("/ts/segment-3.ts"));

    failSegments("/ts/segment-2.ts");
    await unlink(path.join(root, "stream-resume", "tsFile", "000000.ts"));
    const { stdout, stderr } = await download("stream-resume", "ts", ...flags);
    assert.match(stdout, /下载进度: 4\/6-1 \(66\.67%\)/);
    assert.match(stdout, /下载进度: 5\/6-1 \(83\.33%\)/);
    assert.doesNotMatch(stdout, /下载进度: 6\/6/);
    assert.doesNotMatch(stdout + stderr, /Input #0|frame=\s*\d+/);
    assert.deepEqual(stderr.match(/续传前的流式合并已跳过[^\r\n]*/g), ["续传前的流式合并已跳过 1 个下载失败的分片"]);
    assert.doesNotMatch(stderr, /本轮流式合并跳过/);
    assert.ok(requests.includes("/ts/segment-0.ts"));
    assert.ok(requests.includes("/ts/segment-5.ts"));
    assert.ok(!requests.includes("/ts/segment-4.ts"));
    await assertContinuousFile("stream-resume", 10);
});

test("streaming progress combines failures confirmed before and after resuming", async () => {
    const name = "stream-resume-more-failures";
    const flags = ["--streamMerge", "true", "--streamMergeFMP4", "true"];
    failSegments("/ts/segment-1.ts", "/ts/segment-3.ts");
    await assert.rejects(
        download(name, "ts", ...flags, "--maxFailedSegments", "1"),
        (err) => err.code === 1 && /上限/.test(err.stderr)
    );

    failSegments("/ts/segment-4.ts");
    const { stdout } = await download(name, "ts", ...flags, "--maxFailedSegments", "2");
    assert.match(stdout, /下载进度: 2\/6-1 \(33\.33%\)/);
    assert.match(stdout, /下载进度: 4\/6-2 \(66\.67%\) -- ([^/\r\n]+)\/\1 \(/);
});

test("cached download-only mode retains the successful fragments", async () => {
    failSegments("/ts/segment-1.ts");
    const { stderr } = await download("cache-only", "ts", "--noMerge", "true", "--enableDelAfterDone", "true");
    assert.doesNotMatch(stderr, /合并时跳过/);
    await stat(path.join(root, "cache-only", "tsFile", "000005.ts"));
    await assert.rejects(stat(path.join(root, "cache-only.mp4")), { code: "ENOENT" });
});

test("streaming fMP4 includes MAP initialization for each group of successful segments", async () => {
    failSegments("/fmp4/segment-1.m4s", "/fmp4/segment-4.m4s");
    const { stderr } = await download(
        "stream-map",
        "fmp4",
        "--streamMerge",
        "true",
        "--streamMergeFMP4",
        "true",
        "--maxFailedSegments",
        "0.5"
    );
    assert.deepEqual(stderr.match(/分片 \[\d+\] 下载失败(?=\r?$)/gm), ["分片 [1] 下载失败", "分片 [4] 下载失败"]);
    assert.doesNotMatch(stderr, /流式合并中跳过/);
    assert.deepEqual(stderr.match(/本轮流式合并跳过[^\r\n]*/g), ["本轮流式合并跳过 2 个下载失败的分片，编号为 1、4"]);
    await assertContinuousFile("stream-map", 8);
});

test("interrupting a streaming download before the next successful segment leaves the gap retryable", async () => {
    for (const mode of ["mp4", "fmp4"]) {
        const name = `interrupted-${mode}`;
        const flags = ["--streamMerge", "true", "--streamMergeFMP4", String(mode === "fmp4"), "--streamMergeForceMerge", "true"];
        failSegments("/ts/segment-2.ts", "/ts/segment-3.ts");
        const arrival = Promise.withResolvers();
        const release = Promise.withResolvers();
        heldRequest = { pathname: "/ts/segment-4.ts", arrived: arrival.resolve, release: release.promise };
        // Notify only the worker so FFmpeg can finish its current output normally on Windows and Unix.
        const handler = encodeURIComponent(
            "process.stdin.once('data', () => { process.stdin.pause(); process.emit('SIGINT'); });"
        );
        const running = startDownload(name, "ts", flags, ["--import", `data:text/javascript,${handler}`]);
        let stderr;
        try {
            await Promise.race([arrival.promise, running.then(() => assert.fail("worker exited before the held request"))]);
            running.child.stdin.end("interrupt");
            ({ stderr } = await running);
        } finally {
            heldRequest = undefined;
            release.resolve(404);
        }
        assert.match(stderr, /分片 \[2\] 下载失败\r?\n/);
        assert.doesNotMatch(stderr, /流式合并中跳过|本轮流式合并跳过/);
        const checkpoint = JSON.parse(await readFile(path.join(root, name, "stream_merge_state.json"), "utf8"));
        assert.equal(checkpoint.nextOffset, 2);
        assert.equal(checkpoint.skippedCount, 0);
        if (mode === "fmp4") {
            const videoTrack = Object.values(checkpoint.fmp4.tracks).find(({ timescale }) => timescale === 90_000);
            assert.equal(Number(videoTrack.decodeEnd) / videoTrack.timescale, 4);
        }

        failSegments();
        await download(name, "ts", ...flags);
        assert.ok(requests.includes("/ts/segment-2.ts"));
        assert.ok(requests.includes("/ts/segment-3.ts"));
        assert.ok(!requests.includes("/ts/segment-1.ts"));
        if (mode === "fmp4") await assertContinuousFile(name, 12);
        else await stat(path.join(root, `${name}.mp4`));
    }
});

test("a streaming download preserves the checkpoint before an unconfirmed failed tail", async () => {
    failSegments("/ts/segment-4.ts", "/ts/segment-5.ts");
    const flags = ["--streamMerge", "true", "--streamMergeFMP4", "true"];
    await assert.rejects(download("failed-tail", "ts", ...flags), (err) => {
        assert.match(err.stdout, /下载进度: 4\/6 \(66\.67%\)/);
        assert.doesNotMatch(err.stdout, /下载进度: \d+\/6-\d+/);
        assert.doesNotMatch(err.stderr, /本轮流式合并跳过/);
        return err.code === 1 && /末尾 2 个分片下载失败，已保存断点/.test(err.stderr);
    });
    const state = JSON.parse(await readFile(path.join(root, "failed-tail", "stream_merge_state.json"), "utf8"));
    assert.equal(state.nextOffset, 4);
    assert.equal(state.skippedCount, 0);
    await assert.rejects(stat(path.join(root, "failed-tail.mp4")), { code: "ENOENT" });

    failSegments();
    await download("failed-tail", "ts", ...flags);
    assert.ok(requests.includes("/ts/segment-4.ts"));
    assert.ok(requests.includes("/ts/segment-5.ts"));
    await assertContinuousFile("failed-tail", 12);
});

test("unconfirmed failures count toward the streaming limit without advancing the checkpoint", async () => {
    failSegments("/ts/segment-2.ts", "/ts/segment-3.ts", "/ts/segment-4.ts");
    await assert.rejects(
        download("unconfirmed-limit", "ts", "--streamMerge", "true", "--streamMergeFMP4", "true", "--maxFailedSegments", "2"),
        (err) => err.code === 1 && /上限/.test(err.stderr)
    );
    assert.ok(!requests.includes("/ts/segment-5.ts"));
    const state = JSON.parse(await readFile(path.join(root, "unconfirmed-limit", "stream_merge_state.json"), "utf8"));
    assert.equal(state.nextOffset, 2);
    assert.equal(state.skippedCount, 0);
});

test("streaming fMP4 can read a checkpoint created before track times were stored", async () => {
    failSegments("/ts/segment-3.ts");
    const flags = ["--streamMerge", "true", "--streamMergeFMP4", "true", "--skipFailedSegments", "false"];
    await assert.rejects(download("old-checkpoint", "ts", ...flags), (err) => err.code === 1);
    const checkpointPath = path.join(root, "old-checkpoint", "stream_merge_state.json");
    const { nextOffset, totalSegments, useFMP4, parts } = JSON.parse(await readFile(checkpointPath, "utf8"));
    await writeFile(checkpointPath, JSON.stringify({ nextOffset, totalSegments, useFMP4, parts }));

    failSegments();
    await download("old-checkpoint", "ts", ...flags);
    assert.ok(requests.includes("/ts/segment-3.ts"));
    assert.ok(!requests.includes("/ts/segment-2.ts"));
    await assertContinuousFile("old-checkpoint", 12);
});

test("the first media segment and MAP are required even with unlimited skips", async () => {
    failSegments("/fmp4/init.mp4");
    await assert.rejects(
        download("missing-map", "fmp4", "--streamMerge", "true"),
        (err) => err.code === 1 && /MAP 文件下载失败/.test(err.stderr + err.stdout)
    );
    assert.ok(!requests.includes("/fmp4/segment-0.m4s"));

    failSegments("/fmp4/segment-0.m4s");
    await assert.rejects(
        download("missing-first", "fmp4", "--streamMerge", "true"),
        (err) => err.code === 1 && /首分片下载失败/.test(err.stderr + err.stdout)
    );
    assert.ok(!requests.includes("/fmp4/segment-1.m4s"));
});
