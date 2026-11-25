import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { getFixtures, removeRun } from "./local-hls/fixtures.mjs";

const workDir = await mkdtemp(path.join(os.tmpdir(), "mimic-segment-resume-"));
const url = "https://example.test/segment.ts";
process.argv.push("--url", url, "--saveName", "resume", "--workDir", workDir, "--timeout", "300", "--totalTimeout", "2400");

const { impit } = await import("#src/common/fetch.ts");
const { logger } = await import("#src/common/logger.ts");
const { progressTracker } = await import("#src/core/progressTracker.ts");
const { downloadSegment } = await import("#src/core/segment/downloader.ts");

after(async () => {
    await logger.close();
    await removeRun(workDir, os.tmpdir());
});

for (const scenario of [
    { name: "matching-partial", status: 206, range: "bytes 5-10/11", body: " world" },
    { name: "wrong-offset", status: 206, range: "bytes 6-10/11", body: "world", restart: true },
    { name: "no-content-range", status: 206, body: " world", restart: true },
    { name: "short-partial-body", status: 206, range: "bytes 5-10/11", body: " wo", restart: true },
    { name: "range-ignored", status: 200, body: "hello world" },
    { name: "cache-already-complete", status: 416, range: "bytes */11", complete: true },
    { name: "cache-size-mismatch", status: 416, range: "bytes */11", restart: true },
]) {
    test(`a disk download handles ${scenario.name}`, async (t) => {
        const fileName = `${scenario.name}.ts`;
        const filePath = path.join(workDir, fileName);
        const cached = scenario.complete ? "hello world" : "hello";
        await writeFile(`${filePath}.tmp`, cached);
        progressTracker.add("cache", `${scenario.name}.tmp`);

        const requests = [];
        t.mock.method(impit, "fetch", async (_url, { headers }) => {
            requests.push(headers.Range);
            if (requests.length > 1) {
                assert.equal(headers.Range, undefined);
                assert.equal(await stat(`${filePath}.tmp`, { throwIfNoEntry: false }), undefined);
                return new Response("hello world");
            }
            return new Response(scenario.body ?? null, {
                status: scenario.status,
                headers: scenario.range ? { "Content-Range": scenario.range } : {},
            });
        });

        const result = await downloadSegment({ url, filePath, fileName, maxRetries: scenario.restart ? 2 : 1 });
        assert.deepEqual(requests, scenario.restart ? [`bytes=${cached.length}-`, undefined] : [`bytes=${cached.length}-`]);
        assert.deepEqual(result, { ok: true, bytes: 11 });
        assert.equal(await readFile(filePath, "utf8"), "hello world");
        assert.equal(await stat(`${filePath}.tmp`, { throwIfNoEntry: false }), undefined);
    });
}

test("a disguised TS download resumes from its original remote byte offset", async (t) => {
    const { files } = await getFixtures(12, "disk");
    const ts = files.get("/ts/segment-0.ts");
    const prefix = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = Buffer.concat([prefix, ts]);
    const saved = Math.floor(ts.length / 2);
    const offset = prefix.length + saved;
    const fileName = "disguised.ts";
    const filePath = path.join(workDir, fileName);
    const requests = [];

    t.mock.method(impit, "fetch", async (_url, { headers }) => {
        requests.push(headers.Range);
        if (requests.length === 1) {
            return new Response(new ReadableStream({ start: (stream) => stream.enqueue(source.subarray(0, offset)) }));
        }
        assert.equal(await readFile(`${filePath}.tmp.source-offset`, "utf8"), String(prefix.length));
        assert.deepEqual(await readFile(`${filePath}.tmp`), ts.subarray(0, saved));
        return new Response(source.subarray(offset), {
            status: 206,
            headers: { "Content-Range": `bytes ${offset}-${source.length - 1}/${source.length}` },
        });
    });

    const result = await downloadSegment({ url, filePath, fileName, maxRetries: 2, sanitizeMpegTs: true });
    assert.deepEqual(requests, [undefined, `bytes=${offset}-`]);
    assert.deepEqual(result, { ok: true, bytes: ts.length });
    assert.deepEqual(await readFile(filePath), ts);
    assert.equal(await stat(`${filePath}.tmp.source-offset`, { throwIfNoEntry: false }), undefined);
});

test("a corrupt TS source-offset record restarts with an empty cache", async (t) => {
    const { files } = await getFixtures(12, "disk");
    const ts = files.get("/ts/segment-0.ts");
    const fileName = "corrupt-offset.ts";
    const filePath = path.join(workDir, fileName);
    await writeFile(`${filePath}.tmp`, "stale data");
    await writeFile(`${filePath}.tmp.source-offset`, "8junk");
    progressTracker.add("cache", "corrupt-offset.tmp");
    const fetch = t.mock.method(impit, "fetch", async (_url, { headers }) => {
        assert.equal(headers.Range, undefined);
        assert.equal(await stat(`${filePath}.tmp`, { throwIfNoEntry: false }), undefined);
        assert.equal(await stat(`${filePath}.tmp.source-offset`, { throwIfNoEntry: false }), undefined);
        return new Response(ts);
    });

    const result = await downloadSegment({ url, filePath, fileName, maxRetries: 1, sanitizeMpegTs: true });
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(result, { ok: true, bytes: ts.length });
    assert.deepEqual(await readFile(filePath), ts);
});
