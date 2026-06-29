import type { DownloadOptions, DownloadTarget, UserPayload } from "#src/common/types.ts";
import { ATOB, typedEntries } from "#src/common/utils.ts";

export type CLIValues = {
    [K in keyof DownloadOptions]?: DownloadOptions[K] extends boolean ? boolean : string;
} & {
    [K in keyof DownloadTarget]?: string;
} & { arg?: string };

export function buildOptions<T extends object>(obj: T) {
    return Object.fromEntries(
        (Object.entries(obj) as Array<[string, unknown]>).map(([key, value]) => [
            key,
            {
                type: (typeof value === "boolean" ? "boolean" : "string") as "boolean" | "string",
            },
        ])
    ) as {
        [K in keyof T]: {
            type: T[K] extends boolean ? "boolean" : "string";
        };
    };
}

export function parseUserConfig(cliValues: CLIValues, baseConfig: DownloadOptions): UserPayload {
    if (cliValues.arg) {
        if (!cliValues.arg.startsWith("m3u8mimic://")) {
            console.error("❌ 错误：缺少必需的命令行输入参数 '--arg'，或参数格式不正确");
            process.exit(1);
        }
        const arg = cliValues.arg.replace(/^m3u8mimic:\/\//, "").replace(/\/$/, "");
        return JSON.parse(ATOB(arg)) as UserPayload;
    }

    const configRef = {} as UserPayload;

    // 🌟 核心：定义一个精准的泛型设置器，利用 Mapped Type 让 TS 理解 key 和 value 的绑定关系
    const setConfigProperty = <K extends keyof UserPayload>(key: K, value: UserPayload[K]) => {
        configRef[key] = value;
    };

    for (const [key, value] of typedEntries(cliValues)) {
        if (key === "arg" || value === undefined) {
            continue;
        }

        const defaultType = typeof baseConfig[key as keyof DownloadOptions];

        if (defaultType === "number") {
            if (typeof value !== "string") {
                throw new Error(`❌ 错误：'--${String(key)}' 参数必须是数字字符串`);
            }
            setConfigProperty(key, Number(value));
        } else if (key === "headers") {
            if (typeof value !== "string") {
                throw new Error(`❌ 错误：'--${String(key)}' 参数必须是合法的 JSON 字符串`);
            }
            try {
                setConfigProperty(key, JSON.parse(value) as Record<string, string>);
            } catch {
                throw new Error(`❌ 错误：'--${key}' 参数必须是合法的 JSON 字符串`);
            }
        } else {
            setConfigProperty(key, value as UserPayload[typeof key]);
        }
    }
    return configRef;
}
