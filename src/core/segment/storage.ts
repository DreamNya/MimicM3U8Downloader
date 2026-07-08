import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import fs from "node:fs/promises";
import path from "node:path";

export function formatFileInfo(index: number, dir: string): { fileName: string; filePath: string };
export function formatFileInfo(index: number, dir?: undefined): { fileName: string; filePath: undefined };
export function formatFileInfo(index: number, dir?: string): { fileName: string; filePath?: string } {
    const fileName = `${String(index).padStart(6, "0")}.ts`;
    const filePath = dir ? path.join(dir, fileName) : undefined;
    return { fileName, filePath };
}

export async function initResumableDownload(): Promise<boolean> {
    const files = await fs.readdir(config.tsDir);
    await Promise.all(
        files.map(async (file) => {
            const filePath = path.join(config.tsDir, file);
            if (file.endsWith(".ts")) {
                progressTracker.add("success", file);
                const { size } = await fs.stat(filePath);
                progressTracker.recordChunk(size);
            } else if (file.endsWith(".tmp")) {
                progressTracker.add("cache", file);
            }
        })
    );

    const count = progressTracker.size("success");
    if (count > 0) {
        logger.log(`➔ 断点续传分片数：${count}`);
        return true;
    }
    return false;
}
