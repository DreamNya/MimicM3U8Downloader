async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // 判断是否是协议注册/卸载模式
    const hasRegister = args.includes("--register") || args.includes("--unregister");
    // 判断是否是 Worker 模式 (包含 -- 参数)
    const hasArg = args.some((arg) => arg.startsWith("--") || arg.startsWith("m3u8mimic://"));

    if (hasRegister) {
        // 动态导入协议管理模块，避免污染其他模式
        const { runProtocol } = await import("#src/bin/protocol.ts");
        return runProtocol();
    } else if (hasArg) {
        // 动态导入 Worker 模块，此时 cli.ts 的顶层 await 才会安全触发
        const { runWorker } = await import("#src/bin/worker.ts");
        return await runWorker();
    } else {
        // 默认模式：启动本地服务器
        const { runServer } = await import("#src/bin/server.ts");
        return await runServer();
    }
}

main().catch(async (err) => {
    console.error(err);
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
});
