import type { DownloadOptions, DownloadRuntimeConfig, UserPayload } from "#src/common/types.ts";
import { ATOB, sanitizeFilename, typedEntries } from "#src/common/utils.ts";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const defaultConfig: DownloadOptions = {
    browser: "chrome",
    proxyUrl: "",
    concurrency: 16,
    maxRetries: 3,
    timeout: 60000,
    enableDelAfterDone: false,
    noMerge: false,
    forceMerge: false,
    headers: {},
    pauseAfterDone: true,
};
const _config = { ...defaultConfig } as DownloadRuntimeConfig;

export const config: Readonly<DownloadRuntimeConfig> = _config;

export async function initConfig(): Promise<Readonly<DownloadRuntimeConfig>> {
    // 解析命令行参数
    const { values } = parseArgs({
        options: {
            arg: { type: "string" },
            url: { type: "string" },
            saveName: { type: "string" },
            workDir: { type: "string" },
            ...buildOptions(defaultConfig),
        },
        strict: true,
    });

    // 读取全局配置
    const globalConfig: Partial<DownloadOptions> = JSON.parse(
        await fs.readFile(fileURLToPath(import.meta.resolve("#setting/worker.config.json")), "utf-8").catch(() => "{}")
    );

    const userConfig: UserPayload = parseUserConfig(values, defaultConfig);

    Object.assign(_config, globalConfig, userConfig);

    _config.saveName = sanitizeFilename(_config.saveName);

    if (!_config.url || !_config.saveName || !_config.workDir) {
        throw new Error("❌ 错误：配置中缺少核心参数 url / saveName / workDir");
    }
    return config;
}

type CLIValues = {
    [K in keyof UserPayload]?: string;
} & { arg?: string };

function buildOptions<T extends object>(obj: T) {
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

function parseUserConfig(cliValues: CLIValues, baseConfig: DownloadOptions): UserPayload {
    // 🌟 核心：利用解构赋值，把 arg 剥离出来，剩余的属性自动组合成一个全新的 restCliValues 对象
    const { arg, ...restCliValues } = cliValues;
    if (arg) {
        if (!arg.startsWith("m3u8mimic://")) {
            throw new Error("❌ 错误：缺少必需的命令行输入参数 '--arg'，或参数格式不正确");
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
