import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const serverPath = fileURLToPath(import.meta.resolve("#src/bin/worker.ts"));
const nodePath = process.execPath;
const rawCommandValue = `"${nodePath}" "${serverPath}" --arg "%1"`;

// 注册表根路径 （HKCU无需管理员权限）
const REG_KEY = "HKEY_CURRENT_USER\\Software\\Classes\\m3u8mimic";

/**
 * 写入注册表函数
 */
function registerProtocol(): void {
    try {
        execSync(`reg add "${REG_KEY}" /ve /t REG_SZ /d "URL:m3u8mimic Protocol" /f`);
        execSync(`reg add "${REG_KEY}" /v "URL Protocol" /t REG_SZ /d "" /f`);
        const escapedCommandValue = rawCommandValue.replace(/"/g, '\\"');
        execSync(`reg add "${REG_KEY}\\shell\\open\\command" /ve /t REG_SZ /d "${escapedCommandValue}" /f`);
        console.log("🎉 m3u8mimic 协议注册成功");
    } catch (err) {
        console.error("❌ m3u8mimic 协议注册失败:", err);
    }
}

/**
 * 删除注册表函数
 */
function unregisterProtocol(): void {
    try {
        execSync(`reg delete "${REG_KEY}" /f`);
        console.log("🗑️ m3u8mimic 协议卸载成功");
    } catch (err) {
        console.error("❌ m3u8mimic 协议卸载失败:", err);
    }
}

// 3. 使用 parseArgs 解析命令行参数
const { values } = parseArgs({
    options: {
        register: {
            type: "boolean",
        },
        unregister: {
            type: "boolean",
        },
    },
});

if (values.register === true) {
    registerProtocol();
} else if (values.unregister === true) {
    unregisterProtocol();
} else {
    process.exit(1);
}
