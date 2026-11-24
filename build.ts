import { IMPIT_BINDING_ASSET } from "./src/build/impit.ts";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import lockfile from "./package-lock.json" with { type: "json" };
import pkg from "./package.json" with { type: "json" };

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 26 || (nodeMajor === 26 && nodeMinor < 9)) {
    throw new Error("SEA 构建需要 Node.js 26.9.0 或更高版本");
}

const targets = new Map([
    ["win32-x64", { name: "windows-x64", binding: "impit-win32-x64-msvc" }],
    ["linux-x64", { name: "linux-x64", binding: "impit-linux-x64-gnu" }],
    ["darwin-x64", { name: "darwin-x64", binding: "impit-darwin-x64" }],
    ["darwin-arm64", { name: "darwin-arm64", binding: "impit-darwin-arm64" }],
]);
const host = `${process.platform}-${process.arch}`;
const target = targets.get(host);
if (!target) {
    throw new Error(`不支持在 ${host} 上构建 SEA`);
}
if (process.env.TARGET_PLATFORM && process.env.TARGET_PLATFORM !== target.name) {
    throw new Error(`当前 Node.js 只能构建 ${target.name}，无法构建 ${process.env.TARGET_PLATFORM}`);
}

const root = import.meta.dirname;
const require = createRequire(import.meta.url);
const assets: Record<string, string> = {
    "package.json": path.join(root, "package.json"),
    [IMPIT_BINDING_ASSET]: require.resolve(target.binding),
};

function addAssets(directory: string): void {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && !entry.name.endsWith(".node")) {
            const source = path.join(entry.parentPath, entry.name);
            assets[path.relative(root, source).split(path.sep).join("/")] = source;
        }
    }
}

addAssets(path.join(root, "src"));
for (const [packagePath, info] of Object.entries(lockfile.packages)) {
    if (!packagePath || ("dev" in info && info.dev)) {
        continue;
    }
    const directory = path.join(root, packagePath);
    if ("optional" in info && info.optional && !existsSync(path.join(directory, "package.json"))) {
        continue;
    }
    addAssets(directory);
}

const dist = path.join(root, "dist");
const outputDirectory = path.join(dist, `MimicM3U8Downloader-v${pkg.version}-${target.name}`);
const executable = process.platform === "win32" ? "MimicM3U8Downloader.exe" : "MimicM3U8Downloader";
mkdirSync(outputDirectory, { recursive: true });

const staging = mkdtempSync(path.join(dist, ".sea-"));
try {
    const configPath = path.join(staging, "sea.json");
    const output = path.join(staging, executable);
    writeFileSync(
        configPath,
        JSON.stringify({
            main: path.join(root, "src/build/main.ts"),
            mainFormat: "module",
            output,
            useVfs: true,
            disableExperimentalSEAWarning: true,
            execArgvExtension: "none",
            assets,
        })
    );
    execFileSync(process.execPath, ["--build-sea", configPath], { cwd: root, stdio: "inherit" });
    if (process.platform === "darwin") {
        execFileSync("codesign", ["--force", "--sign", "-", output], { stdio: "inherit" });
    }

    mkdirSync(path.join(outputDirectory, "config"), { recursive: true });
    for (const file of [
        "README.md",
        "package.json",
        "config/[example]server.setting.json",
        "config/[example]worker.setting.json",
    ]) {
        copyFileSync(path.join(root, file), path.join(outputDirectory, file));
    }
    renameSync(output, path.join(outputDirectory, executable));
    console.log(`SEA 构建完成 → ${path.relative(root, outputDirectory)}`);
} finally {
    rmSync(staging, { recursive: true, force: true });
}
