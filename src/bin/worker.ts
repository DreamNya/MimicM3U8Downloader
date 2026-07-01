import fs from "node:fs/promises";
import path from "node:path";
import { M3u8Downloader } from "#src/core/downloader.ts";
import { initLogger } from "#src/common/logger.ts";
import { Impit } from "impit";
import { initConfig } from "#src/common/cli.ts";
import { waitBeforeExit } from "#src/common/utils.ts";

const config = await initConfig().catch(async (err) => {
    console.error(err);
    await waitBeforeExit();
    process.exit(1);
});

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
    const downloader = new M3u8Downloader({ workDir, tempDir, tsDir });
    await downloader.start();
} catch {
    process.exitCode = 1;
} finally {
    await logger.close();
    if (config.pauseAfterDone) {
        await waitBeforeExit();
    }
}
