import fs from "fs";

class Logger {
    #FILEPATH;
    #stream;
    constructor(TEMP_DIR: string) {
        this.#FILEPATH = `${TEMP_DIR}/${Date.now()}.log`;
        this.#stream = fs.createWriteStream(this.#FILEPATH, { flags: "a", encoding: "utf8" });
    }

    log(message: string, { print = true, log = true, colorful = false } = {}): void {
        const timeStamp = this.now();
        if (print) {
            if (colorful) {
                const [line0, ...lines] = message.split("\n");

                console.log(
                    `${timeStamp} \x1b[38;2;193;156;0m${line0}\x1b[0m${lines.length ? `\n${" ".repeat(timeStamp.length + 1)}` + lines.join(`\n${" ".repeat(timeStamp.length + 1)}`) : ""}`
                );
            } else {
                console.log(`${timeStamp} ${message}`);
            }
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} log] ${message}\n`);
        }
    }
    warn(message: string, { print = true, log = true } = {}): void {
        const timeStamp = this.now();
        if (print) {
            console.warn(`${timeStamp} ${message}`);
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} WARN] ${message}\n`);
        }
    }
    error(message: string, { print = true, log = true } = {}): void {
        const timeStamp = this.now();
        if (print) {
            console.error(`${timeStamp} ${message}`);
        }
        if (log && this.#stream.writable) {
            this.#stream.write(`[${timeStamp} ERROR] ${message}\n`);
        }
    }
    print(message: string): void {
        const timeStamp = this.now();
        process.stdout.write(`\r\x1b[K${timeStamp} ${message}`);
    }
    close(): Promise<void> {
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
}

export let logger: Logger;

export function initLogger(tempDir: string) {
    logger = new Logger(tempDir);
    return logger;
}
