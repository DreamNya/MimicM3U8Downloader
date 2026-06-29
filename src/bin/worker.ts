import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { DownloadOptions, DownloadRuntimeConfig, UserPayload } from "#src/common/types.ts";
import { sanitizeFilename } from "#src/common/utils.ts";
import { M3u8Downloader } from "#src/core/downloader.ts";
import { initLogger } from "#src/common/logger.ts";
import { Impit } from "impit";
import { fileURLToPath } from "node:url";
import { buildOptions, parseUserConfig } from "#src/common/cli.ts";

const defaultConfig: DownloadOptions = {
    browser: "chrome",
    proxyUrl: "",
    concurrency: 16,
    maxRetries: 3,
    timeout: 60000,
    enableDelAfterDone: false,
    noMerge: false,
    forceMerge: false,
    headers: {},
    pauseAfterDone: true,
};

// 解析命令行参数
const { values } = parseArgs({
    options: {
        arg: { type: "string" },
        url: { type: "string" },
        saveName: { type: "string" },
        workDir: { type: "string" },
        ...buildOptions(defaultConfig),
    },
    strict: true,
});

// 读取全局配置
const globalConfig: Partial<DownloadOptions> = JSON.parse(
    await fs.readFile(fileURLToPath(import.meta.resolve("#setting/worker.config.json")), "utf-8").catch(() => "{}")
);

const userConfig: UserPayload = parseUserConfig(values, defaultConfig);

const config: DownloadRuntimeConfig = {
    ...defaultConfig,
    ...globalConfig,
    ...userConfig,
};

config.saveName = sanitizeFilename(config.saveName);

if (!config.url || !config.saveName || !config.workDir) {
    console.error("❌ 错误：配置中缺少核心参数 url / saveName / workDir");
    process.exit(1);
}

export const impit = new Impit({
    browser: config.browser,
    proxyUrl: config.proxyUrl || undefined,
    ignoreTlsErrors: true,
    timeout: config.timeout,
    headers: config.headers,
});

console.log("MimicM3U8Downloader\n\n");

const workDir = config.workDir.replace(/\/$/, "");
const tempDir = path.join(workDir, config.saveName);
const tsDir = path.join(tempDir, "tsFile");
await fs.mkdir(tsDir, { recursive: true });
const logger = initLogger(tempDir);

process.on("unhandledRejection", (error) => {
    logger.error(`【全局捕获】未处理的 Promise 拒绝：${error}`, { print: false });
    process.exitCode = 1;
});
process.on("uncaughtException", (error) => {
    logger.error(`【全局捕获】未捕获的异常：${error}`, { print: false });
    process.exitCode = 1;
});

// 实例化下载器并运行
try {
    const downloader = new M3u8Downloader(config, { workDir, tempDir, tsDir });
    await downloader.start();
} catch {
    process.exitCode = 1;
} finally {
    await logger.close();
    if (config.pauseAfterDone) {
        console.log("\n\n按任意键退出程序...");
        await new Promise<void>((resolve) => {
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();
            process.stdin.once("data", () => {
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.pause();
                resolve();
            });
        });
    }
}
