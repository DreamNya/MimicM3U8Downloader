import { getErrorMessage } from "#src/common/utils.ts";
import fs from "fs";
import type { WriteStream } from "node:tty";
import path from "path";

const clearLine = "\r\x1b[K";

class Logger {
    #tempDir!: string;
    #FILEPATH!: string;
    #stream!: fs.WriteStream;
    #progressLine?: string;

    init(tempDir: string) {
        this.#tempDir = tempDir;
        this.#FILEPATH = path.join(tempDir, `${Date.now()}.log`);
        this.#stream = fs.createWriteStream(this.#FILEPATH, { flags: "a", encoding: "utf8" });
    }

    log(message: string, { print = true, log = true, colorful = false } = {}): void {
        const timeStamp = this.now();
        if (print) {
            if (colorful) {
                const [line0, ...lines] = message.split("\n");

                this.#writeConsole(
                    `${timeStamp} \x1b[38;2;193;156;0m${line0}\x1b[0m${lines.length ? `\n${" ".repeat(timeStamp.length + 1)}` + lines.join(`\n${" ".repeat(timeStamp.length + 1)}`) : ""}`
                );
            } else {
                this.#writeConsole(`${timeStamp} ${message}`);
            }
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} log] ${message}\n`);
        }
    }

    warn(message: string, { print = true, log = true } = {}): void {
        const timeStamp = this.now();
        if (print) {
            this.#writeConsole(`${timeStamp} ${message}`, process.stderr);
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} WARN] ${message}\n`);
        }
    }

    error(message: string, { print = true, log = true } = {}): void {
        const timeStamp = this.now();
        if (print) {
            this.#writeConsole(`${timeStamp} ${message}`, process.stderr);
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} ERROR] ${message}\n`);
        }
    }

    print(message: string): void {
        this.#progressLine = `${this.now()} ${message}`;
        process.stdout.write(clearLine + this.#fitProgressLine(this.#progressLine));
    }

    endProgress(): void {
        if (this.#progressLine !== undefined) {
            this.#progressLine = undefined;
            process.stdout.write("\n");
        }
    }

    #writeConsole(message: string, output: WriteStream = process.stdout): void {
        if (this.#progressLine !== undefined && process.stdout.isTTY && output.isTTY) {
            // 一次写入清除、日志和重绘，避免 stdout 与 stderr 交错。
            process.stdout.write(`${clearLine}${message}\n${this.#fitProgressLine(this.#progressLine)}`);
            return;
        }

        if (output === process.stdout) this.endProgress();
        output.write(`${message}\n`);
    }

    #fitProgressLine(line: string): string {
        const columns = process.stdout.columns;
        if (!columns) return line;

        // 进度行只包含 ASCII 和中文，留出最后一列以免终端自动换行。
        let remaining = columns - 1;
        let visible = "";
        for (const character of line) {
            remaining -= character.charCodeAt(0) <= 0x7f ? 1 : 2;
            if (remaining < 0) break;
            visible += character;
        }
        return visible;
    }

    async close(): Promise<void> {
        if (!this.#stream) {
            return;
        }
        return new Promise((resolve) => {
            if (!this.#stream.writable) {
                return resolve();
            }
            // 等待当缓冲区数据全部刷新并写入磁盘
            this.#stream.end(() => {
                resolve();
            });
        });
    }

    now(): string {
        return new Date().toLocaleTimeString("zh-CN", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            fractionalSecondDigits: 3,
        });
    }

    file(fileName: string, data: string): void {
        fs.promises
            .writeFile(path.join(this.#tempDir, fileName), data)
            .catch((err) => this.error(`文件 [${fileName}] 写入失败：${getErrorMessage(err)}`));
    }
}

export const logger = new Logger();
