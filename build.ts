// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import fs from "node:fs";
import pkg from "./package.json";

const version = pkg.version;

const targetMaps = ["bun-windows-x64", "bun-linux-x64", "bun-darwin-arm64", "bun-darwin-x64"];

// 从环境变量获取当前构建目标
let target = process.env.TARGET_PLATFORM;
if (!target) {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === "win32" && arch === "x64") {
        target = "bun-windows-x64";
    } else if (platform === "linux" && arch === "x64") {
        target = "bun-linux-x64";
    } else if (platform === "darwin" && arch === "arm64") {
        target = "bun-darwin-arm64";
    } else if (platform === "darwin" && arch === "x64") {
        target = "bun-darwin-x64";
    }
}

if (!target || !targetMaps.includes(target)) {
    console.error(`❌ 未知或不支持的构建目标。支持列表: ${targetMaps.join(", ")}`);
    process.exit(1);
}

console.log(`\n🚀 [自动注入模式] 正在编译目标平台: ${target}...`);
const targetDir = target.replace("bun", `MimicM3U8Downloader-${version}`);

// 让 Bun 自动解析并打包所有依赖（包括 .node 二进制模块）
await Bun.build({
    entrypoints: ["./src/build/main.ts"],
    minify: true,
    compile: {
        target: target,
        outfile: `./dist/${targetDir}/MimicM3U8Downloader`,
        ...(target === "bun-windows-x64" && {
            windows: {
                title: "MimicM3U8Downloader",
                publisher: "DreamNya",
                version,
                description: "MimicM3U8Downloader",
                copyright: "Copyright 2026 DreamNya",
            },
        }),
    },
});

fs.copyFileSync("README.md", `dist/${targetDir}/README.md`);
fs.copyFileSync("package.json", `dist/${targetDir}/package.json`);
fs.mkdirSync(`dist/${targetDir}/config`, { recursive: true });
fs.copyFileSync("config/[example]server.setting.json", `dist/${targetDir}/config/[example]server.setting.json`);
fs.copyFileSync("config/[example]worker.setting.json", `dist/${targetDir}/config/[example]worker.setting.json`);
console.log(`✨ 平台 ${target} 纯单文件编译完成 -> dist/${targetDir}\n`);
