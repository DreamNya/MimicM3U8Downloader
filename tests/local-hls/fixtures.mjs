import { spawn } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const segmentSeconds = 2;
export const variants = ["ts", "fmp4", "aes-ts", "aes-ts-sequence", "aes-fmp4"];
const localEnv = { ...process.env, NO_PROXY: "127.0.0.1,localhost" };
export const cacheRoot = path.resolve(".cache/local-hls");
export const pipeMp4 = ["-movflags", "+delay_moov+frag_keyframe+default_base_moof", "-f", "mp4", "pipe:1"];

export async function run(command, args, input) {
    const child = spawn(command, args, { env: localEnv, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    // FFmpeg may close the pipe before EOF after finding enough frames or on error.
    child.stdin?.on("error", (error) => {
        if (error.code !== "EPIPE" && error.code !== "EOF") {
            stderr.push(Buffer.from(error.message));
            child.kill();
        }
    });
    child.stdin?.end(input);
    const [code, signal] = await once(child, "close");
    if (code !== 0) {
        throw new Error(`${command} exited with ${code ?? signal}\n${Buffer.concat(stderr).toString().trim()}`);
    }
    return Buffer.concat(stdout);
}

async function listen(handler) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}

function encryptVariant(files, source, target, key, explicitIv) {
    const playlist = files.get(`/${source}/media.m3u8`).toString();
    const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="key.bin"${explicitIv ? `,IV=0x${explicitIv.toString("hex")}` : ""}`;
    const encryptedPlaylist = playlist.replace(/^#EXT-X-PLAYLIST-TYPE:VOD$/m, `$&\n${keyTag}`);
    for (const [name, bytes] of files) {
        if (!name.startsWith(`/${source}/`) || name.endsWith(".m3u8")) {
            continue;
        }
        const iv = explicitIv ?? Buffer.alloc(16);
        if (!explicitIv) {
            iv.writeUInt32BE(Number(name.match(/segment-(\d+)\.ts$/)[1]), 12);
        }
        const cipher = createCipheriv("aes-128-cbc", key, iv);
        files.set(name.replace(`/${source}/`, `/${target}/`), Buffer.concat([cipher.update(bytes), cipher.final()]));
    }
    files.set(`/${target}/media.m3u8`, Buffer.from(encryptedPlaylist));
    files.set(`/${target}/key.bin`, key);
}

async function generate(seconds) {
    const reference = await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=25",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        String(seconds),
        "-vf",
        "drawtext=text='%{pts\\:hms}':fontsize=24:fontcolor=white:x=10:y=10",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-g",
        String(25 * segmentSeconds),
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        ...pipeMp4,
    ]);
    const files = new Map();
    const upload = await listen(async (request, response) => {
        if (request.method !== "PUT" || !/^\/(ts|fmp4)\/(media\.m3u8|init\.mp4|segment-\d+\.(ts|m4s))$/.test(request.url)) {
            response.writeHead(404).end();
            return;
        }
        try {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }
            files.set(request.url, Buffer.concat(chunks));
            response.writeHead(201).end();
        } catch {
            response.destroy();
        }
    });
    try {
        for (const [variant, format, extension] of [
            ["ts", "mpegts", "ts"],
            ["fmp4", "fmp4", "m4s"],
        ]) {
            const base = `${upload.origin}/${variant}`;
            await run(
                "ffmpeg",
                [
                    "-v",
                    "error",
                    "-i",
                    "pipe:0",
                    "-c",
                    "copy",
                    "-f",
                    "hls",
                    "-method",
                    "PUT",
                    "-hls_time",
                    String(segmentSeconds),
                    "-hls_playlist_type",
                    "vod",
                    "-hls_segment_type",
                    format,
                    "-hls_flags",
                    "independent_segments",
                    "-hls_segment_filename",
                    `${base}/segment-%d.${extension}`,
                    `${base}/media.m3u8`,
                ],
                reference
            );
            const playlist = files.get(`/${variant}/media.m3u8`)?.toString();
            if (
                playlist?.match(/^#EXTINF:/gm)?.length !== seconds / segmentSeconds ||
                (variant === "fmp4" && !files.has("/fmp4/init.mp4"))
            ) {
                throw new Error(`Incomplete FFmpeg HLS fixture for ${variant}`);
            }
            for (let index = 0; index < seconds / segmentSeconds; index++) {
                if (!files.get(`/${variant}/segment-${index}.${extension}`)?.length) {
                    throw new Error(`Missing ${variant} segment ${index}`);
                }
            }
        }
    } finally {
        await upload.close();
    }

    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const iv = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    encryptVariant(files, "ts", "aes-ts", key, iv);
    encryptVariant(files, "ts", "aes-ts-sequence", key);
    encryptVariant(files, "fmp4", "aes-fmp4", key, iv);
    return { reference, files };
}

export async function removeRun(directory, parent) {
    const [resolvedDirectory, resolvedParent] = await Promise.all([fs.realpath(directory), fs.realpath(parent)]);
    if (path.dirname(resolvedDirectory) !== resolvedParent) {
        throw new Error(`Refusing to remove a directory outside ${resolvedParent}`);
    }
    await fs.rm(resolvedDirectory, { recursive: true });
}

export async function getFixtures(seconds, storage) {
    if (storage === "memory") {
        return generate(seconds);
    }

    const parent = path.join(cacheRoot, "fixtures");
    const directory = path.join(parent, `v1-${seconds}s`);
    async function load() {
        const reference = await fs.readFile(path.join(directory, "reference.mp4"));
        const files = new Map();
        for (const variant of variants) {
            const source = path.join(directory, variant);
            for (const file of await fs.readdir(source)) {
                files.set(`/${variant}/${file}`, await fs.readFile(path.join(source, file)));
            }
        }
        return { reference, files, directory, cacheHit: true };
    }
    try {
        return await load();
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    const { reference, files } = await generate(seconds);
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, "build-"));
    let published = false;
    try {
        await fs.writeFile(path.join(staging, "reference.mp4"), reference);
        for (const variant of variants) {
            await fs.mkdir(path.join(staging, variant));
        }
        for (const [file, bytes] of files) {
            await fs.writeFile(path.join(staging, file.slice(1)), bytes);
        }
        try {
            await fs.rename(staging, directory);
            published = true;
        } catch (error) {
            try {
                return await load(); // Another build may have populated this cache.
            } catch {
                throw error;
            }
        }
        return { reference, files, directory };
    } finally {
        if (!published) {
            await removeRun(staging, parent);
        }
    }
}

const contentTypes = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".m4s": "video/iso.segment",
    ".mp4": "video/mp4",
};

export function serveFixtures(files, onRequest) {
    return listen(async (request, response) => {
        const name = request.url.split("?")[0];
        const asset = files.get(name);
        const failure = await onRequest?.(name, request.headers.range);
        if (response.destroyed) {
            return;
        }
        if (failure || !asset) {
            response.writeHead(failure || 404).end();
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" }).end();
            return;
        }

        const headers = {
            "Content-Type": contentTypes[path.extname(name)] ?? "application/octet-stream",
            "Accept-Ranges": "bytes",
        };
        let status = 200;
        let body = asset;
        if (request.headers.range) {
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
            const start = Number(range?.[1]);
            const end = range?.[2] ? Math.min(Number(range[2]), asset.length - 1) : asset.length - 1;
            if (!range || start >= asset.length || end < start) {
                response.writeHead(416, { "Content-Range": `bytes */${asset.length}` }).end();
                return;
            }
            body = asset.subarray(start, end + 1);
            status = 206;
            headers["Content-Range"] = `bytes ${start}-${end}/${asset.length}`;
        }
        response
            .writeHead(status, { ...headers, "Content-Length": body.length })
            .end(request.method === "HEAD" ? undefined : body);
    });
}
