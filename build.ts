// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import pkg from "./package.json";

const version = pkg.version;
const libsDir = "./libs";
const destDir = "./libs/binaries";

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    const files = fs.readdirSync(libsDir);
    for (const file of files) {
        if (file.endsWith(".tgz")) {
            const tarPath = `${libsDir}/${file}`;
            const tempDir = `${libsDir}/${file.replace(/\.tgz$/, "")}`;

            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            // 调用系统 tar 命令解压到目录
            await $`tar -xzf ${tarPath} -C ${tempDir}`;
            const pkgDir = `${tempDir}/package`;
            if (fs.existsSync(pkgDir)) {
                const pkgFiles = fs.readdirSync(pkgDir);
                for (const pf of pkgFiles) {
                    if (pf.endsWith(".node")) {
                        const srcNode = `${pkgDir}/${pf}`;
                        const destNode = `${destDir}/${pf}`;
                        await $`cp ${srcNode} ${destNode}`;
                    }
                }
            }
        }
    }
}

const impitRedirectPlugin = {
    name: "impit-redirect-plugin",
    setup(build: {
        onResolve: (
            arg0: { filter: RegExp },
            arg1: (args: { importer: string | string[] }) => { path: string } | undefined
        ) => void;
    }) {
        // 精准拦截 impit 内部引用 "./index.js" 的动作
        build.onResolve({ filter: /^\.\/index(\.js)?$/ }, (args: { importer: string | string[] }) => {
            // 确保这个引用的发起者（importer）是在 impit 依赖包内部
            if (args.importer.includes("impit")) {
                return { path: path.resolve("./src/build/impit-adapter.ts") };
            }
        });
    },
};
const targetMaps = {
    "bun-windows-x64": "impit-node.win32-x64-msvc.node",
    "bun-linux-x64": "impit-node.linux-x64-gnu.node",
    "bun-darwin-arm64": "impit-node.darwin-arm64.node",
    "bun-darwin-x64": "impit-node.darwin-x64.node",
};
for (const [target, libName] of Object.entries(targetMaps)) {
    console.log(`正在编译目标平台: ${target}...`);
    const targetDir = target.replace("bun", "MimicM3U8Downloader");
    await Bun.build({
        entrypoints: ["./src/build/main.ts"],
        minify: true,
        // 声明 impit-node 为外部依赖，不打包
        external: ["impit-node"],
        plugins: [impitRedirectPlugin],
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

    fs.mkdirSync(`dist/${targetDir}/lib/`, { recursive: true });
    fs.copyFileSync(`${destDir}/${libName}`, `dist/${targetDir}/lib/${libName}`);
    fs.copyFileSync("README.md", `dist/${targetDir}/README.md`);
    fs.copyFileSync("package.json", `dist/${targetDir}/package.json`);
    fs.cpSync("config", `dist/${targetDir}/config`, { recursive: true });
    await $`powershell -Command "Compress-Archive -Path '${`dist/${targetDir}/*`}' -DestinationPath 'dist/${targetDir}.zip' -CompressionLevel Optimal -Force"`;
}
