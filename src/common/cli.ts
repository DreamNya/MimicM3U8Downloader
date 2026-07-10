import type { DownloadInputConfig, DownloadOptions, DownloadRuntimeConfig, UserPayload } from "#src/common/types.ts";
import { ATOB, sanitizeFilename, typedEntries, waitBeforeExit } from "#src/common/utils.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

const defaultConfig: DownloadOptions = {
    browser: "chrome",
    proxyUrl: "",
    headers: {},
    range: "",
    concurrency: 16,
    maxRetries: 3,
    timeout: 60000,
    streamMerge: false,
    streamMergeFMP4: false,
    streamMergeForceMerge: false,
    noMerge: false,
    forceMerge: false,
    enableDelAfterDone: false,
    pauseAfterDone: true,
    debug: false,
};

export const config: Readonly<DownloadRuntimeConfig> = await initConfig().catch(async (err) => {
    console.error(err);
    await waitBeforeExit();
    process.exit(1);
});

async function initConfig(): Promise<Readonly<DownloadRuntimeConfig>> {
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
    const globalConfigPath = getSettingPath("worker.setting.json");
    const globalConfig: Partial<DownloadOptions> = JSON.parse(
        await fs.readFile(globalConfigPath, "utf-8").catch(() => {
            console.log("⚠️ 未读取到 config/worker.setting.json 将使用 Payload 或默认设置");
            return "{}";
        })
    );

    const userConfig: UserPayload = parseUserConfig(values, defaultConfig);

    const config = await formatConfig({
        ...defaultConfig,
        ...globalConfig,
        ...userConfig,
    });

    if (!config.url || !config.saveName || !config.workDir) {
        throw new Error("❌ 错误：配置中缺少核心参数 url / saveName / workDir");
    }
    return config;
}

export async function formatConfig(config: DownloadInputConfig): Promise<DownloadRuntimeConfig> {
    const saveName = sanitizeFilename(config.saveName);
    const workDir = config.workDir.replace(/\/$/, "");
    const tempDir = path.join(workDir, saveName);
    const tsDir = path.join(tempDir, "tsFile");
    const outputFile = path.join(workDir, `${saveName}.mp4`);

    await fs.mkdir(tsDir, { recursive: true });

    return {
        ...config,
        saveName,
        workDir,
        tempDir,
        tsDir,
        outputFile,
    };
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
