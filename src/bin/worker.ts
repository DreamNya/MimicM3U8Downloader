import pkg from "#package" with { type: "json" };
import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { safetyExit } from "#src/common/utils.ts";
import { M3U8Downloader } from "#src/core/downloader/m3u8Downloader.ts";

console.log(`MimicM3U8Downloader v${pkg.version}\n\n`);

export async function runWorker() {
    process.on("unhandledRejection", (error) => {
        logger.error(`【未处理的 Promise 拒绝】${error}`);
        process.exitCode = 1;
    });
    process.on("uncaughtException", (error) => {
        logger.error(`【未捕获的异常】${error}`);
        process.exitCode = 1;
    });

    // 实例化下载器并运行
    try {
        // TODO
        await new M3U8Downloader().start();
    } catch {
        process.exitCode = 1;
    } finally {
        await safetyExit(config.pauseAfterDone);
    }
}

// 如果通过node直接运行
if (process.argv[1] === import.meta.filename) {
    runWorker();
}
