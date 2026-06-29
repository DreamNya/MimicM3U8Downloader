/**
 * 中文 Base64 解码
 */
export function ATOB(str: string): string {
    return new TextDecoder().decode(Uint8Array.from(atob(str), (m) => m.codePointAt(0) ?? 0));
}
/**
 * 中文 Base64 编码
 */
export function BTOA(str: string): string {
    return btoa(String.fromCodePoint(...new TextEncoder().encode(str)));
}

/**
 * 字节单位转换
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) {
        return "0 B";
    }
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * 格式化时长
 */
export function formatTime(rawS: number): string {
    const s = Math.floor(rawS);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    const pad = (v: number) => String(v).padStart(2, "0");
    return [d > 0 ? `${d}d` : "", d > 0 || h > 0 ? `${pad(h)}h` : "", `${pad(m)}m`, `${pad(sec)}s`].join("");
}

/**
 * 格式化文件名
 */
export function sanitizeFilename(name: string): string {
    return name
        .trim()
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/[. ]+$/, "")
        .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i, "_$&")
        .slice(0, 255);
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

export function typedEntries<T extends object>(obj: T) {
    return Object.entries(obj) as Array<[keyof T, T[keyof T]]>;
}
