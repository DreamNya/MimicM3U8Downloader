import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const workDir = await mkdtemp(path.join(os.tmpdir(), "mimic-stream-order-"));
process.argv.push("--url", "https://example.test/playlist.m3u8", "--saveName", "order", "--workDir", workDir);
const { impit } = await import("#src/common/fetch.ts");
const { logger } = await import("#src/common/logger.ts");
const { downloadSegmentsInOrder } = await import("#src/core/segment/pipeline.ts");

after(async () => {
    await logger.close();
    await rm(workDir, { recursive: true, force: true });
});

function startDownloads(t) {
    const segments = Array.from({ length: 5 }, (_, index) => ({ url: `https://example.test/${index}.ts`, index, duration: 2 }));
    const requests = [];
    const head = Promise.withResolvers();
    const controller = new AbortController();
    t.mock.method(impit, "fetch", async (url) => {
        const index = segments.findIndex((segment) => segment.url === url);
        const firstAttempt = !requests.includes(index);
        requests.push(index);
        if (firstAttempt && index === 1) {
            return head.promise;
        }
        if (firstAttempt && index === 2) {
            return new Response(null, { status: 503 });
        }
        return new Response(String(index));
    });

    const downloads = downloadSegmentsInOrder({
        segments,
        concurrency: 2,
        maxRetries: 2,
        startIndex: 1,
        signal: controller.signal,
        sanitizeMpegTs: false,
        failFast: true,
    });
    t.after(async () => {
        controller.abort();
        head.resolve(new Response("1"));
        await downloads.return();
    });
    return { downloads, requests, head };
}

test("a blocked stream head keeps the window fixed and retries before later segments", async (t) => {
    const { downloads, requests, head } = startDownloads(t);
    const first = downloads.next();

    // The later fragment's backoff elapses while the head is still downloading.
    await sleep(1100);
    assert.deepEqual(requests, [1, 2]);

    head.resolve(new Response(null, { status: 503 }));
    const received = [(await first).value];
    for await (const result of downloads) {
        received.push(result);
    }
    assert.deepEqual(
        received.map(({ index, buffer }) => [index, buffer.toString()]),
        [
            [1, "1"],
            [2, "2"],
            [3, "3"],
            [4, "4"],
        ]
    );
    assert.deepEqual(
        requests.filter((index) => index <= 2),
        [1, 2, 1, 2]
    );
});

test("closing a stream releases a queued retry without starting it", async (t) => {
    const { downloads, requests, head } = startDownloads(t);
    const first = downloads.next();
    await sleep(1100);
    head.resolve(new Response("1"));
    assert.equal((await first).value.index, 1);

    await downloads.return();
    assert.deepEqual(requests, [1, 2]);
});
