import { close, createWriteStream, open, write } from "node:fs";
import { isSea } from "node:sea";

// Node.js 26 SEA VFS 缺少 writev 处理器，通过 write 写入真实文件。
const seaWriteFs = isSea() ? { close, open, write } : undefined;

export function createFileWriteStream(file: string, options: { flags: string; encoding?: BufferEncoding }) {
    return createWriteStream(file, { ...options, fs: seaWriteFs });
}
