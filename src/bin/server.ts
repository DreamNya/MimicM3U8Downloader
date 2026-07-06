import { BTOA, getErrorMessage } from "#src/common/utils.ts";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 保证在开发环境读取项目根目录，在 SEA 环境读取 .exe 同级的 setting
function getSettingPath(fileName: string): string {
    const exeName = path.basename(process.execPath).toLowerCase();
    // 无论是 Node.js SEA 还是 Bun Compile，编译成单文件后，可执行文件名都不会是 node 或 bun
    const isCompiled = !exeName.startsWith("node") && !exeName.startsWith("bun");
    if (isCompiled) {
        return path.join(path.dirname(process.execPath), "config", fileName);
    } else {
        return fileURLToPath(import.meta.resolve(`#config/${fileName}`));
    }
}

function getWorkerPath(): string {
    return fileURLToPath(import.meta.resolve(`#src/bin/worker.ts`));
}

function getRequestBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", (err) => reject(err)); // 传输层出错也能捕获
    });
}

export async function runServer(): Promise<void> {
    const settingPath = getSettingPath("server.setting.json");
    // JSON解析失败则立即抛出错误终止运行
    const { Port = 12345 } = JSON.parse(await fs.readFile(settingPath, "utf-8").catch(() => "{}"));
    return new Promise<void>((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                if (req.method == "POST") {
                    const rawBody = await getRequestBody(req);
                    const json = JSON.parse(rawBody.toString());
                    const arg = "m3u8mimic://" + BTOA(JSON.stringify(json));
                    console.log("收到请求", json);
                    const exeName = path.basename(process.execPath).toLowerCase();
                    const isCompiled = !exeName.startsWith("node") && !exeName.startsWith("bun");
                    const cmdArgs = isCompiled
                        ? ["/c", "start", "cmd", "/c", `""${process.execPath}"`, "--arg", `"${arg}""`]
                        : ["/c", "start", "cmd", "/c", "node", `"${getWorkerPath()}"`, "--arg", `"${arg}"`];
                    const child = spawn("cmd.exe", cmdArgs, {
                        detached: true,
                        stdio: "ignore",
                        windowsVerbatimArguments: true,
                    });

                    // 主进程不等待子进程
                    child.unref();
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("ok");
                } else {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("Not Found");
                }
            } catch (err) {
                console.error(err);
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end(getErrorMessage(err));
            }
        });

        server.listen(Port, "127.0.0.1", () => {
            console.log(
                `\n⚡ MimicM3U8Downloader 本地监听服务已就绪\n- 运行环境: 127.0.0.1\n- 监听端口: ${Port}\n=========================================`
            );
            resolve();
        });
        server.on("error", (err) => {
            reject(err);
        });
    });
}
