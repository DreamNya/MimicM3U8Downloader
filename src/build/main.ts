async function main() {
    const args = process.argv.slice(2);

    // 判断是否是协议注册/卸载模式
    const hasRegister = args.includes("--register");
    const hasUnregister = args.includes("--unregister");

    // 判断是否是 Worker 模式 (包含 -- 参数)
    const hasArg = args.some((arg) => arg.startsWith("--") || arg.startsWith("m3u8mimic://"));

    if (hasRegister || hasUnregister) {
        // 动态导入协议管理模块，避免污染其他模式
        const { runProtocol } = await import("#src/bin/protocol.ts");
        runProtocol();
    } else if (hasArg) {
        // 动态导入 Worker 模块，此时 cli.ts 的顶层 await 才会安全触发
        const { runWorker } = await import("#src/bin/worker.ts");
        await runWorker();
    } else {
        // 默认模式：启动本地服务器
        const { runServer } = await import("#src/bin/server.ts");
        await runServer();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
