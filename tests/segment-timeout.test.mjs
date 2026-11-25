import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const workDir = await mkdtemp(path.join(os.tmpdir(), "mimic-segment-timeout-"));
const url = "https://example.test/segment.ts";
const timeout = 300;
const totalTimeout = 2_400;
process.argv.push(
    "--url",
    url,
    "--saveName",
    "timeout",
    "--workDir",
    workDir,
    "--timeout",
    String(timeout),
    "--totalTimeout",
    String(totalTimeout)
);

const { fetchSegment, impit } = await import("#src/common/fetch.ts");
const { logger } = await import("#src/common/logger.ts");
const { downloadSegment } = await import("#src/core/segment/downloader.ts");
const { downloadSegmentsInOrder } = await import("#src/core/segment/pipeline.ts");

after(async () => {
    await logger.close();
    await rm(workDir, { recursive: true, force: true });
});

test("slow segments with regular chunks finish in both download modes", async (t) => {
    t.mock.method(impit, "fetch", async (_url, options) => {
        assert.equal(options.timeout, totalTimeout);
        let chunks = 0;
        return new Response(
            new ReadableStream({
                async pull(stream) {
                    await sleep(75);
                    stream.enqueue(Buffer.from("x"));
                    if (++chunks === 8) {
                        stream.close();
                    }
                },
            })
        );
    });

    const filePath = path.join(workDir, "slow.ts");
    const disk = downloadSegment({ url, filePath, fileName: "slow.ts", maxRetries: 1 });
    const memory = downloadSegmentsInOrder({
        segments: [{ url, index: 0, duration: 1 }],
        concurrency: 1,
        maxRetries: 1,
        startIndex: 0,
        signal: new AbortController().signal,
        sanitizeMpegTs: false,
        failFast: true,
    });

    const [result, segments] = await Promise.all([disk, Array.fromAsync(memory)]);
    assert.deepEqual(result, { ok: true, bytes: 8 });
    assert.equal(await readFile(filePath, "utf8"), "xxxxxxxx");
    assert.deepEqual(segments, [{ index: 0, buffer: Buffer.from("xxxxxxxx") }]);
});

test("an idle disk download retries with the already written byte offset", async (t) => {
    const requests = [];
    let cancelled = false;
    t.mock.method(impit, "fetch", async (_url, { headers }) => {
        requests.push(headers.Range);
        if (requests.length === 1) {
            return new Response(
                new ReadableStream({
                    start(stream) {
                        stream.enqueue(Buffer.from("hello"));
                    },
                    cancel() {
                        cancelled = true;
                    },
                })
            );
        }
        return new Response(" world", { status: 206, headers: { "Content-Range": "bytes 5-10/11" } });
    });

    const filePath = path.join(workDir, "resumed.ts");
    const result = await downloadSegment({ url, filePath, fileName: "resumed.ts", maxRetries: 2 });
    assert.deepEqual(requests, [undefined, "bytes=5-"]);
    assert.equal(cancelled, true);
    assert.deepEqual(result, { ok: true, bytes: 11 });
    assert.equal(await readFile(filePath, "utf8"), "hello world");
});

test("waiting for response headers has its own timeout", async (t) => {
    t.mock.method(
        impit,
        "fetch",
        async (_url, { signal }) =>
            new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            })
    );

    await assert.rejects(fetchSegment(url, {}), /等待分片响应头超时/);
});

test("concurrent bodies share one clock and reuse their read timers across chunks", async (t) => {
    const intervals = t.mock.method(globalThis, "setInterval");
    const clearIntervals = t.mock.method(globalThis, "clearInterval");
    const timeouts = t.mock.method(globalThis, "setTimeout");
    t.mock.method(impit, "fetch", async () => {
        return new Response(
            new ReadableStream({
                start(stream) {
                    for (let i = 0; i < 4; i++) {
                        stream.enqueue(Buffer.from("x"));
                    }
                    stream.close();
                },
            })
        );
    });

    const responses = await Promise.all([fetchSegment(url, {}), fetchSegment(url, {})]);
    const headerTimers = timeouts.mock.callCount();
    assert.equal(intervals.mock.callCount(), 1);

    const bodies = await Promise.all(responses.map(({ body }) => Array.fromAsync(body)));
    assert.deepEqual(
        bodies.map((chunks) => Buffer.concat(chunks).toString()),
        ["xxxx", "xxxx"]
    );
    assert.equal(timeouts.mock.callCount() - headerTimers, 2);
    assert.equal(clearIntervals.mock.callCount(), 1);
});

test("the timeout follows the current pending read across a pause between pulls", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const advance = (ms) => {
        now += ms;
        t.mock.timers.tick(ms);
    };

    const waitingForData = Promise.withResolvers();
    let source;
    let requestSignal;
    t.mock.method(impit, "fetch", async (_url, { signal }) => {
        requestSignal = signal;
        return new Response(
            new ReadableStream(
                {
                    start(stream) {
                        source = stream;
                    },
                    pull() {
                        waitingForData.resolve();
                    },
                },
                { highWaterMark: 0 }
            )
        );
    });

    const { body } = await fetchSegment(url, {});
    const reader = body.getReader();
    t.after(() => reader.cancel().catch(() => void 0));
    source.enqueue(Buffer.from("a"));
    await reader.read();
    advance(timeout + 60);
    assert.equal(requestSignal.aborted, false);

    source.enqueue(Buffer.from("b"));
    await reader.read();
    advance(timeout - 10);
    const stalled = assert.rejects(reader.read(), /分片响应体连续 300 毫秒未收到数据/);
    await waitingForData.promise;

    // The carried-over timer expires ten milliseconds into this read.
    advance(10);
    assert.equal(requestSignal.aborted, false);
    advance(timeout - 1);
    assert.equal(requestSignal.aborted, false);
    advance(1);
    await stalled;
});
