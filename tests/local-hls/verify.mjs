import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cacheRoot, pipeMp4, removeRun, run, segmentSeconds, serveFixtures, variants } from "./fixtures.mjs";
import { checkTimeline, hashFrames } from "./media.mjs";

async function downloadToMemory(url, options, range, skip) {
    const { mock } = await import("node:test");
    // The Worker CLI initializes a filesystem workspace and file logger on import.
    const config = { browser: "chrome", headers: {}, timeout: 5_000, totalTimeout: 15_000 };
    const cli = mock.module("#src/common/cli.ts", { exports: { config } });
    const { logger } = await import("#src/common/logger.ts");
    const logs = ["log", "warn", "error"].map((method) => mock.method(logger, method, () => {}));

    try {
        const { fetchSegment } = await import("#src/common/fetch.ts");
        const { M3u8Parser } = await import("#src/core/m3u8Parser.ts");
        const { filterSegmentsByRange } = await import("#src/core/segment/filter.ts");
        const { createSegmentStream, preflightKeys } = await import("#src/core/segment/crypto.ts");
        const { downloadSegmentsInOrder } = await import("#src/core/segment/pipeline.ts");
        const { segments, mapInfo } = await new M3u8Parser(url).parse();
        const selected = filterSegmentsByRange(range, segments);
        await preflightKeys(selected, mapInfo?.keyInfo);

        const buffers = [];
        if (mapInfo) {
            const { response, body } = await fetchSegment(mapInfo.url, {});
            assert.ok(response.ok && body, `Failed to fetch MAP: ${response.status}`);
            buffers.push(...(await Array.fromAsync(createSegmentStream(body, mapInfo.keyInfo))));
        }
        for await (const result of downloadSegmentsInOrder({
            segments: selected,
            concurrency: 4,
            maxRetries: options.scenario === "retry" ? 2 : 1,
            startIndex: 0,
            signal: AbortSignal.timeout(60_000),
            sanitizeMpegTs: !mapInfo,
            failFast: skip === undefined,
        })) {
            if ("error" in result) {
                if (selected[result.index].index !== skip) {
                    throw result.error;
                }
            } else {
                buffers.push(result.buffer);
            }
        }
        return await run(
            "ffmpeg",
            [
                "-v",
                "error",
                ...(skip === undefined ? ["-xerror"] : []),
                "-i",
                "pipe:0",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-c",
                "copy",
                "-bsf:a",
                "aac_adtstoasc",
                ...pipeMp4,
            ],
            Buffer.concat(buffers)
        );
    } finally {
        for (const log of logs) {
            log.mock.restore();
        }
        cli.restore();
    }
}

async function downloadWithWorker(url, options, name, directory, range, releaseFailure) {
    const args = [
        "src/bin/worker.ts",
        "--url",
        url,
        "--saveName",
        name,
        "--workDir",
        directory,
        "--proxyUrl",
        "",
        "--headers",
        "{}",
        "--range",
        range,
        "--pauseAfterDone",
        "false",
        "--concurrency",
        "1",
        "--maxRetries",
        options.scenario === "retry" ? "2" : "1",
        "--timeout",
        "5000",
        "--totalTimeout",
        "15000",
        "--streamMerge",
        String(options.mode !== "normal"),
        "--streamMergeFMP4",
        String(options.mode === "fmp4"),
        "--streamMergeForceMerge",
        "true",
        "--noMerge",
        "false",
        "--forceMerge",
        "false",
        "--debug",
        "false",
        "--skipFailedSegments",
        String(options.scenario === "skip" || options.scenario === "resume"),
        "--maxFailedSegments",
        "1",
        "--enableDelAfterDone",
        "true",
    ];
    if (options.scenario === "resume") {
        await assert.rejects(run(process.execPath, args), /末尾 1 个分片下载失败，已保存断点/);
        const checkpoint = JSON.parse(await fs.readFile(path.join(directory, name, "stream_merge_state.json"), "utf8"));
        assert.equal(checkpoint.nextOffset, options.seconds / segmentSeconds - 1);
        assert.equal(checkpoint.skippedCount, 0);
        releaseFailure();
    }
    await run(process.execPath, args);
    return path.join(directory, `${name}.mp4`);
}

function samplePositions(length, count, join) {
    const limit = Math.min(length, count);
    if (limit === 1) {
        return [join ?? Math.floor(length / 2)];
    }
    // Prefer both sides of a skip or resume boundary.
    const boundary = join === undefined ? [] : [join - 1, join];
    const evenlySpaced = Array.from({ length: limit }, (_, i) => Math.round((i * (length - 1)) / (limit - 1)));
    return [...new Set([...boundary, ...evenlySpaced])].slice(0, limit).sort((a, b) => a - b);
}

export async function verify(options, fixtures) {
    const names = options.variant === "all" ? variants : [options.variant];
    const segmentCount = options.seconds / segmentSeconds;
    const middle = Math.floor(segmentCount / 2);
    const range = options.scenario === "range" ? `1-${segmentCount - 2}` : "";
    const skip = options.scenario === "skip" ? middle : undefined;
    const target = options.scenario === "resume" ? segmentCount - 1 : middle;
    const expectedIndexes = Array.from({ length: segmentCount }, (_, index) => index).filter(
        (index) => index !== skip && (!range || (index > 0 && index < segmentCount - 1))
    );
    const join = options.scenario === "resume" ? target : skip;
    const positions = samplePositions(expectedIndexes.length, options.samples, join);
    const referenceIndexes = positions.map((position) => expectedIndexes[position]);
    const expectedHashes = await hashFrames(fixtures.reference, referenceIndexes);

    let failedSegment;
    const requests = [];
    let failureStatus;
    const server = await serveFixtures(fixtures.files, (name, requestRange) => {
        requests.push({ name, range: requestRange });
        if (name === failedSegment) {
            const status = failureStatus;
            if (options.scenario === "retry") {
                failureStatus = undefined;
            }
            return status;
        }
    });

    const runsRoot = path.join(cacheRoot, "runs");
    const scratchParent = options.video === "disk" ? runsRoot : (options["ram-dir"] ?? "/dev/shm");
    let scratch;
    let artifacts;
    let passed = false;
    try {
        if (options.engine === "worker") {
            if (options.video === "disk") {
                await fs.mkdir(runsRoot, { recursive: true });
            }
            scratch = await fs.mkdtemp(path.join(scratchParent, "hls-"));
        }
        const videos = new Map();
        const report = [];
        for (const name of names) {
            requests.length = 0;
            const extension = name.endsWith("fmp4") ? "m4s" : "ts";
            failedSegment = `/${name}/segment-${target}.${extension}`;
            failureStatus = { retry: 503, skip: 404, resume: 404 }[options.scenario];
            const url = `${server.origin}/${name}/media.m3u8`;
            try {
                const video =
                    options.engine === "memory"
                        ? await downloadToMemory(url, options, range, skip)
                        : await downloadWithWorker(url, options, name, scratch, range, () => {
                              failureStatus = undefined;
                          });
                const actualHashes = await hashFrames(video, positions);
                assert.deepEqual(actualHashes, expectedHashes, "Decoded keyframes differ from the source");
                const checkContinuity = skip === undefined || (options.engine === "worker" && options.mode === "fmp4");
                const durations = await checkTimeline(
                    video,
                    checkContinuity ? expectedIndexes.length * segmentSeconds : undefined
                );
                const segmentRequests = requests.map(({ name }) => name).filter((name) => /\/segment-\d+\./.test(name));
                const expectedRequests = expectedIndexes.map((index) => `/${name}/segment-${index}.${extension}`);
                if (["retry", "skip", "resume"].includes(options.scenario)) {
                    expectedRequests.push(failedSegment);
                }
                assert.deepEqual(segmentRequests.sort(), expectedRequests.sort(), "Unexpected segment requests");
                if (options.video === "disk" && options.engine === "memory") {
                    videos.set(name, video);
                }
                console.log(
                    `PASS ${name} ${options.scenario} (${positions.length} keyframes, ${segmentRequests.length} segment requests)`
                );
                report.push({ variant: name, durations, referenceIndexes, hashes: actualHashes, requests: [...requests] });
            } catch (error) {
                throw new Error(`${name} ${options.scenario} failed: ${error.message}`, { cause: error });
            }
        }

        if (options.video === "disk" || options.verification === "disk") {
            await fs.mkdir(runsRoot, { recursive: true });
            artifacts = options.video === "disk" && scratch ? scratch : await fs.mkdtemp(path.join(runsRoot, "hls-"));
            for (const [name, video] of videos) {
                await fs.writeFile(path.join(artifacts, `${name}.mp4`), video);
            }
            if (options.verification === "disk") {
                const result = { engine: options.engine, scenario: options.scenario, seconds: options.seconds, report };
                await fs.writeFile(path.join(artifacts, "verification.json"), JSON.stringify(result, null, 4) + "\n");
            }
            console.log(`Saved artifacts to ${artifacts}`);
        }
        passed = true;
    } finally {
        try {
            await server.close();
        } finally {
            if (scratch && (!passed || options.video === "memory")) {
                await removeRun(scratch, scratchParent);
            }
            if (!passed && artifacts && artifacts !== scratch) {
                await removeRun(artifacts, runsRoot);
            }
        }
    }
}
