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

export interface StreamMergeState {
    nextOffset: number;
    totalSegments: number;
    useFMP4: boolean;
    parts: string[];
}

/**
 * 读取并校验流式断点状态
 */
async function readStreamMergeState(
    stateFilePath: string,
    currentTotalSegments: number,
    useFMP4: boolean
): Promise<StreamMergeState | null> {
    try {
        const content = await fs.readFile(stateFilePath, "utf-8");
        const state = JSON.parse(content) as Partial<StreamMergeState>;

        // 校验结构、当前分片总数是否与历史记录完全一致
        if (
            useFMP4 === state.useFMP4 &&
            typeof state.nextOffset === "number" &&
            typeof state.totalSegments === "number" &&
            state.totalSegments === currentTotalSegments &&
            Array.isArray(state.parts) &&
            state.parts.length > 0
        ) {
            logger.log(`➔ 流式断点续传分片数：${state.nextOffset}`);
            return {
                useFMP4: state.useFMP4,
                nextOffset: state.nextOffset,
                totalSegments: state.totalSegments,
                parts: state.parts,
            };
        }
    } catch {
        // 文件不存在、损坏或解析失败
    }
    return null;
}

export function initStreamMergeState(
    stateFilePath: string,
    currentTotalSegments: number,
    useFMP4: boolean
): Promise<StreamMergeState | null> {
    return readStreamMergeState(stateFilePath, currentTotalSegments, useFMP4);
}

/**
 * 持久化写入流式断点状态
 */
export async function writeStreamMergeState(stateFilePath: string, state: StreamMergeState): Promise<void> {
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), "utf-8");
}
