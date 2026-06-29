import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { BTOA, getErrorMessage } from "#src/common/utils.ts";
import { fileURLToPath } from "node:url";

// JSON解析失败则立即抛出错误终止运行
const { Port = 12345 } = JSON.parse(
    await fs.readFile(fileURLToPath(import.meta.resolve("#setting/server.config.json")), "utf-8").catch(() => "{}")
);
const worker = fileURLToPath(import.meta.resolve("#src/bin/worker.ts"));

http.createServer(async (req, res) => {
    try {
        if (req.method == "POST") {
            const data: Buffer[] = [];
            req.on("data", (chuck: Buffer) => data.push(chuck));
            req.on("end", async () => {
                const json = JSON.parse(Buffer.concat(data).toString());
                const arg = "m3u8mimic://" + BTOA(JSON.stringify(json));
                console.log("收到请求", json);

                const child = spawn("cmd.exe", ["/c", "start", "cmd", "/k", "node", worker, "--arg", arg], {
                    detached: true,
                    stdio: "ignore",
                    windowsVerbatimArguments: true,
                });
                // 主进程不等待子进程
                child.unref();
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("ok");
            });
        } else {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Not Found");
        }
    } catch (err) {
        console.error(err);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(getErrorMessage(err));
    }
}).listen(Port, "127.0.0.1", () => {
    console.log(
        `\n⚡ MimicM3U8Downloader 本地监听服务已就绪\n- 运行环境: 127.0.0.1\n- 监听端口: ${Port}\n=========================================`
    );
});
