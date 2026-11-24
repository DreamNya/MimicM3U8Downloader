import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRawAsset } from "node:sea";

export const IMPIT_BINDING_ASSET = "native/impit.node";

function matchesBinding(file: string, digest: string): boolean {
    try {
        return hash("sha256", readFileSync(file)) === digest;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function cacheWindowsBinding(data: Uint8Array): string {
    // Windows 会锁住已加载的 DLL，按内容复用，避免每次启动都留下一个副本。
    const digest = hash("sha256", data);
    const cache = path.join(tmpdir(), "MimicM3U8Downloader-impit");
    const binding = path.join(cache, `${digest}.node`);
    if (matchesBinding(binding, digest)) {
        return binding;
    }

    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(path.join(cache, "extract-"));
    try {
        const file = path.join(staging, "impit.node");
        writeFileSync(file, data, { mode: 0o600 });
        try {
            renameSync(file, binding);
        } catch (error) {
            // Windows 上，另一个进程可能已经提取并加载了同一个 DLL。
            if (!matchesBinding(binding, digest)) {
                throw error;
            }
        }
        return binding;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

export function extractImpitBinding(): string {
    // Node.js 必须从真实文件系统加载原生模块。
    const data = new Uint8Array(getRawAsset(IMPIT_BINDING_ASSET));
    if (process.platform === "win32") {
        return cacheWindowsBinding(data);
    }

    const directory = mkdtempSync(path.join(tmpdir(), "mimic-impit-"));
    const binding = path.join(directory, "impit.node");
    const cleanup = () => rmSync(directory, { recursive: true, force: true });
    try {
        writeFileSync(binding, data, { mode: 0o600 });
    } catch (error) {
        cleanup();
        throw error;
    }
    process.once("exit", cleanup);
    return binding;
}
