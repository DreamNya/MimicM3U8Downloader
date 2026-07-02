import { config } from "#src/common/cli.ts";
import { logger } from "#src/common/logger.ts";
import { waitBeforeExit } from "#src/common/utils.ts";
import { M3U8Downloader } from "#src/core/m3u8Downloader.ts";

console.log("MimicM3U8Downloader\n\n");

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
    // TODO
    await new M3U8Downloader().start();
} catch {
    process.exitCode = 1;
} finally {
    await logger.close();
    if (config.pauseAfterDone) {
        await waitBeforeExit();
    }
}
