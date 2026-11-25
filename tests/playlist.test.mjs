import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { removeRun } from "./local-hls/fixtures.mjs";

const workDir = await mkdtemp(path.join(os.tmpdir(), "mimic-playlist-test-"));
const mediaUrl = "https://example.test/video/media.m3u8";
process.argv.push("--url", mediaUrl, "--saveName", "playlist", "--workDir", workDir);

const { impit } = await import("#src/common/fetch.ts");
const { logger } = await import("#src/common/logger.ts");
const { M3u8Parser } = await import("#src/core/m3u8Parser.ts");
const { createSegmentStream, preflightKeys } = await import("#src/core/segment/crypto.ts");

after(async () => {
    await logger.close();
    await removeRun(workDir, os.tmpdir());
});

function playlist(...lines) {
    return ["#EXTM3U", ...lines].join("\n");
}

test("a nested master selects the highest bandwidth and resolves paths against each playlist", async (t) => {
    const masterUrl = "https://example.test/catalog/master.m3u8";
    const nestedUrl = "https://example.test/catalog/hd/master.m3u8";
    const manifests = new Map([
        [masterUrl, playlist("#EXT-X-STREAM-INF:BANDWIDTH=100", "low.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=800", "hd/master.m3u8")],
        [
            nestedUrl,
            playlist(
                "#EXT-X-STREAM-INF:BANDWIDTH=750",
                "../mid.m3u8",
                "#EXT-X-STREAM-INF:BANDWIDTH=900",
                "../../video/media.m3u8"
            ),
        ],
        [mediaUrl, playlist("#EXTINF:2.5,", "segments/first.ts?token=abc", "#EXTINF:1.5,", "../second.ts", "#EXT-X-ENDLIST")],
    ]);
    const fetch = t.mock.method(
        impit,
        "fetch",
        async (url) => new Response(manifests.get(url), { status: manifests.has(url) ? 200 : 404 })
    );

    const { segments, totalDuration, rawMasterContent, rawMediaContent } = await new M3u8Parser(masterUrl).parse();
    assert.deepEqual(
        fetch.mock.calls.map(({ arguments: [url] }) => url),
        [masterUrl, nestedUrl, mediaUrl]
    );
    assert.equal(rawMasterContent, manifests.get(masterUrl));
    assert.equal(rawMediaContent, manifests.get(mediaUrl));
    assert.equal(totalDuration, 4);
    assert.deepEqual(
        segments.map(({ url, duration }) => [url, duration]),
        [
            ["https://example.test/video/segments/first.ts?token=abc", 2.5],
            ["https://example.test/second.ts", 1.5],
        ]
    );
});

test("an implicit AES IV uses the playlist media sequence without changing segment indexes", async (t) => {
    const input = playlist(
        "#EXT-X-MEDIA-SEQUENCE:4294967338",
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        "#EXTINF:2,",
        "first.ts",
        "#EXTINF:2,",
        "second.ts"
    );
    t.mock.method(impit, "fetch", async () => new Response(input));

    const { segments } = await new M3u8Parser(mediaUrl).parse();
    assert.deepEqual(
        segments.map(({ index }) => index),
        [0, 1]
    );
    assert.deepEqual(
        segments.map(({ keyInfo }) => keyInfo.iv.toString("hex")),
        ["0000000000000000000000010000002a", "0000000000000000000000010000002b"]
    );
});

test("AES segments decrypt with rotating keys and METHOD=NONE clears the previous key", async (t) => {
    const input = playlist(
        '#EXT-X-KEY:METHOD=AES-128,URI="first.key",IV=0x01',
        "#EXTINF:2,",
        "one.ts",
        "#EXTINF:2,",
        "two.ts",
        '#EXT-X-KEY:METHOD=AES-128,URI="../second.key",IV=0x02',
        "#EXTINF:2,",
        "three.ts",
        "#EXT-X-KEY:METHOD=NONE",
        "#EXTINF:2,",
        "four.ts"
    );
    const firstKeyUrl = "https://example.test/video/first.key";
    const secondKeyUrl = "https://example.test/second.key";
    const keys = new Map([
        [firstKeyUrl, Buffer.alloc(16, 1)],
        [secondKeyUrl, Buffer.alloc(16, 2)],
    ]);
    const fetch = t.mock.method(impit, "fetch", async (url) => new Response(url === mediaUrl ? input : keys.get(url)));

    const { segments } = await new M3u8Parser(mediaUrl).parse();
    assert.deepEqual(
        segments.map(({ keyInfo }) => keyInfo?.url),
        [firstKeyUrl, firstKeyUrl, secondKeyUrl, undefined]
    );
    await preflightKeys(segments);
    assert.deepEqual(
        fetch.mock.calls.map(({ arguments: [url] }) => url),
        [mediaUrl, ...keys.keys()]
    );

    const expected = ["first", "same key", "rotated key", "clear"];
    const decoded = [];
    for (const [index, keyByte] of [1, 1, 2, 0].entries()) {
        const clear = Buffer.from(expected[index]);
        let data = clear;
        if (keyByte) {
            const iv = Buffer.alloc(16);
            iv[15] = keyByte;
            const cipher = createCipheriv("aes-128-cbc", Buffer.alloc(16, keyByte), iv);
            data = Buffer.concat([cipher.update(clear), cipher.final()]);
        }
        const stream = createSegmentStream(new Response(data).body, segments[index].keyInfo);
        decoded.push(Buffer.concat(await Array.fromAsync(stream)).toString());
    }
    assert.deepEqual(decoded, expected);
});

test("AES key preflight rejects a key with a nonstandard length", async (t) => {
    const keyUrl = "https://example.test/invalid.key";
    const fetch = t.mock.method(impit, "fetch", async () => new Response(Buffer.alloc(15)));
    const segments = [{ url: mediaUrl, index: 0, duration: 2, keyInfo: { method: "AES-128", url: keyUrl } }];

    await assert.rejects(preflightKeys(segments), /期待 16 字节，实际收到 15 字节/);
    assert.deepEqual(fetch.mock.calls[0].arguments, [keyUrl]);
});
