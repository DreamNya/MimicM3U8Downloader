import type { DownloadOptions, UserPayload } from "./types.ts";
import { ATOB } from "./utils.ts";

export function parseUserConfig(cliValues: Record<string, unknown>, baseConfig: DownloadOptions): UserPayload {
    if (typeof cliValues.arg === "string") {
        if (!cliValues.arg.startsWith("m3u8mimic://")) {
            console.error("❌ 错误：缺少必需的命令行输入参数 '--arg'，或参数格式不正确");
            process.exit(1);
        }
        const arg = cliValues.arg.replace(/^m3u8mimic:\/\//, "").replace(/\/$/, "");
        return JSON.parse(ATOB(arg)) as UserPayload;
    }

    const configRef: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(cliValues)) {
        if (key === "arg") {
            continue;
        }

        const defaultType = typeof baseConfig[key as keyof DownloadOptions];

        if (defaultType === "number") {
            configRef[key] = Number(value);
        } else if (defaultType === "object" && key === "headers") {
            try {
                configRef[key] = JSON.parse(value as string);
            } catch {
                console.error(`❌ 错误：'--${key}' 参数必须是合法的 JSON 字符串`);
                process.exit(1);
            }
        } else {
            configRef[key] = value;
        }
    }
    return configRef as unknown as UserPayload;
}
