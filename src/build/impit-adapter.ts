import os from "os";
import path from "path";

const exeDir = path.dirname(process.execPath);
const platform = os.platform();
const arch = os.arch();
let binaryName = "";
if (platform === "win32" && arch === "x64") {
    binaryName = "impit-node.win32-x64-msvc.node";
} else if (platform === "linux" && arch === "x64") {
    binaryName = "impit-node.linux-x64-gnu.node";
} else if (platform === "darwin" && arch === "arm64") {
    binaryName = "impit-node.darwin-arm64.node";
} else if (platform === "darwin" && arch === "x64") {
    binaryName = "impit-node.darwin-x64.node";
} else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

const nativeBindingPath = path.join(exeDir, "lib", binaryName);

// 直接将底层的 C++ 导出对象作为 CommonJS 模块导出
// 这样可以完美顶替原本 node_modules/impit/index.js 的位置
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = require(nativeBindingPath);
