import type { DownloadOptions, UserPayload } from "#src/common/types.ts";
import { ATOB, typedEntries } from "#src/common/utils.ts";

type CLIValues = {
    [K in keyof UserPayload]?: string;
} & { arg?: string };

export function buildOptions<T extends object>(obj: T) {
    return Object.fromEntries(
        Object.keys(obj).map((key) => [
            key,
            {
                type: "string" as const,
            },
        ])
    ) as {
        [K in keyof T]: {
            type: "string";
        };
    };
}

export function parseUserConfig(cliValues: CLIValues, baseConfig: DownloadOptions): UserPayload {
    // 🌟 核心：利用解构赋值，把 arg 剥离出来，剩余的属性自动组合成一个全新的 restCliValues 对象
    const { arg, ...restCliValues } = cliValues;
    if (arg) {
        if (!arg.startsWith("m3u8mimic://")) {
            console.error("❌ 错误：缺少必需的命令行输入参数 '--arg'，或参数格式不正确");
            process.exit(1);
        }
        const parsedArg = arg.replace(/^m3u8mimic:\/\//, "").replace(/\/$/, "");
        return JSON.parse(ATOB(parsedArg)) as UserPayload;
    }

    const configRef = {} as UserPayload;

    // 🌟 核心：定义一个精准的泛型设置器，利用 Mapped Type 让 TS 理解 key 和 value 的绑定关系
    const setConfigProperty = <K extends keyof UserPayload>(key: K, value: UserPayload[K]) => {
        configRef[key] = value;
    };

    for (const [key, value] of typedEntries(restCliValues)) {
        if (value === undefined) {
            continue;
        }

        const defaultType = typeof baseConfig[key as keyof DownloadOptions];

        if (defaultType === "number") {
            if (typeof value !== "string") {
                throw new Error(`❌ 错误：'--${String(key)}' 参数必须是数字字符串`);
            }
            setConfigProperty(key, Number(value));
        } else if (defaultType === "boolean") {
            if (value !== "true" && value !== "false") {
                throw new Error(`❌ 错误：'--${String(key)}' 参数必须是 'true' 或 'false'`);
            }
            setConfigProperty(key, value === "true");
        } else if (key === "headers") {
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
