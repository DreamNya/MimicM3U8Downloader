# MimicM3U8Downloader 拟态M3U8下载器

🚀 **一款可对抗防爬策略的反TLS指纹 M3U8 视频流下载器**

本项目基于 `impit` 库，能够**完美模拟真实浏览器的 TLS 指纹**，绕过人机验证，实现稳定、高速的m3u8分片下载与自动合并

---

## ✨ 项目特性

* **TLS 指纹混淆**：模拟 Chrome 等主流浏览器的 TLS 握手特征，绕过 Cloudflare 防爬校验
* **多级 M3U8 嵌套解析**：支持 Master Playlist 递归解析，自动提取 BaseURL 并精准锁定最高清晰度视频流
* **动态 AES 解密**：流式解密标准 AES-128 加密分片，支持多密钥自动识别与平滑切换
* **精准区间下载**： 支持解析并下载指定范围（Range）的分片，满足按需下载需求
* **流式断点续传**：集成分片完整性校验机制，支持中断进度秒传，大幅减少重复 I/O 损耗
* **多线程高效并发**：采用多线程异步并发请求，最大化利用网络带宽，提升下载吞吐量
* **FFmpeg 自动封装**：分片下载完成后自动调用 FFmpeg，实现无损、快速的合并与封装
* **三模一体化运行**

  1. **CLI 模式**：直接通过 Node.js 调用下载器
  2. **HTTP 本地服务**：通过本地服务器 http 请求，一键唤醒下载器
  3. **URL Protocol 协议**：支持浏览器或外部网页通过URL Protocol 协议唤醒下载器

### 预览

![preview](./preview/output.gif)

---

## 🛠️ 前置准备

1. **Node.js**

   安装 **Node.js v23.6.0 或更高版本**  (推荐: Node.js v24+ / latest LTS)
   （低版本Node.js请手动添加flag`--experimental-strip-types`或使用`ts-node`）

2. **FFmpeg**

   请确保已经安装 FFmpeg，并正确配置**环境变量**

---

## 📦 安装与配置

### 1. 克隆项目

```bash
git clone https://github.com/DreamNya/MimicM3U8Downloader.git
cd MimicM3U8Downloader
npm install
```

---

## 2. 配置文件说明

项目包含两个全局配置文件，位于 `setting/` 目录。

### 📂 setting/server.config.json

本地 http 服务器配置参数

| 参数              | 类型    | 默认值  | 说明
| ----------------- | ------- | --------| -------------------------------------------------
| `Port`            | string  | `12345` | 本地 http 服务监听端口

---

### 📂 setting/worker.config.json

下载器全局配置参数

| 参数                 | 类型    | 默认值     | 说明
| -------------------- | ------- | ---------- | -------------------------------------------------
| `browser`            | string  | `"chrome"` | 模拟 TLS 指纹浏览器名称 详见<https://apify.github.io/impit/js/types/Browser.html>
| `proxyUrl`           | string  | `""`       | 代理服务器地址，例如 `http://127.0.0.1:10808`
| `headers`            | object  | `{}`       | 请求头（同时用于请求m3u8文件及分片）（Referer、Cookies 等）
| `range`              | string  | `""`       | 分片选择范围 详见 [range设置格式](#range设置格式)
| `concurrency`        | number  | `16`       | 分片迸发请求数
| `maxRetries`         | number  | `3`        | 网络请求失败时自动重试次数（403 404时不会重试）
| `timeout`            | number  | `60000`    | 网络请求的超时毫秒（包含请求及连接时间，如果分片过大建议提高超时时间）
| `enableDelAfterDone` | boolean | `false`    | 下载完毕后删除临时文件夹
| `noMerge`            | boolean | `false`    | 分片下载完毕不自动合并
| `forceMerge`         | boolean | `false`    | 下分片下载不完整时强制合并
| `pauseAfterDone`     | boolean | `true`     | 下载完毕后暂停交互窗口
| `debug`              | boolean | `false`    | 记录debug中间产物

---

### 🌐 Payload

每次调用下载器时必须传递的参数

| 参数             | 类型    | 是否必须传递   | 说明
| ---------------- | ------- | -------------- | -------------------------------------------------
| `url`            | string  | 必须           | m3u8 请求地址
| `saveName`       | string  | 必须           | 视频存储文件名（不包括后缀）
| `workDir`        | number  | 必须           | 视频存储目录（临时文件也会存储在该目录下）

其余非必须传递参数与下载器全局配置参数规则相同，如果传递则在该次调用中覆盖全局配置中对应的配置

### 配置附录

#### range设置格式

*以下格式2选1，不可混用

| 范围分类         | 示例格式                                 | 实际下载范围 / 行为说明
| ---------------- | ---------------------------------------- | ------------------------------------------
| **索引格式**     | `"123,128,130"`                          | 仅下载索引为 123、128、130 的分片，多段之间用逗号 `,` 分割
| (数字索引)       | `"120-"`                                 | 下载从第 120 分片开始的所有后续分片
|                  | `"120-200"`                              | 下载闭区间 120 ~ 200 之间的所有分片
|                  | `"-200"`                                 | 下载从开头第 0 分片到第 200 分片的所有分片
|                  | `"110,120-130,150-180,185"`              | 支持复合区间（用`,`分隔）：同时下载 110、120～130、150～180 以及 185 分片
| **时间轴格式**   | `"00:00:28-"`                            | 下载视频 28 秒之后的所有分片
| (时间文本)       | `"-00:10:00"`                            | 下载视频 10 分钟之前的所有分片
|                  | `"00:00:28-00:10:00"`                    | 下载视频 28 秒到 10 分钟之间的所有分片
|                  | `"00:00:28-00:10:00,00:15:00-00:16:00"`  | 支持复合时间（用`,`分隔）：下载 28 秒～10 分钟 和 15 分钟～16 分钟内的所有分片

#### 配置优先级

同一配置项存在多个来源时，按以下优先级覆盖（高 → 低）：

1. `Payload` 传递的参数
2. `worker.config.json` 中配置的全局静态参数
3. 下载器默认兜底参数

## 🚀 使用方法

下载器接收的数据格式为：

```text
m3u8mimic://<Base64(JSON Payload)>
```

Payload 格式参考

```json
{
  "url": "https://example.com/target.m3u8",
  "saveName": "视频保存名称",
  "workDir": "D:/m3u8",
  "headers": {
    "Referer": "https://example.com/",
    "Origin": "https://example.com/",
    "Cookie": "XXX",
  }
}
```

中文Base64编码参考

``` ts
function BTOA(str: string): string {
    return btoa(String.fromCodePoint(...new TextEncoder().encode(str)));
}
```

---

### 模式一：HTTP 本地服务

适合作为浏览器脚本或其他应用调用。

启动服务：

```bash
npm run server
```

默认监听：

```text
http://127.0.0.1:12345
```

* **请求示例（UserScript）**

```javascript
GM_xmlhttpRequest({
    url: 'http://127.0.0.1:12345',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    data: JSON.stringify({
        url: 'https://example.com/target.m3u8',
        saveName: '视频保存名称',
        workDir: 'D:/m3u8',
        headers: {
            Referer: location.href,
        },
    }),
    onload: (xhr) => console.log(xhr),
});
```

服务端会自动：

1. 将 Payload 编码为 Base64。
2. 拉起新的 CMD 窗口。
3. 启动独立下载任务。

---

### 模式二：URL Protocol 浏览器唤醒

注册 Windows URL Protocol 后，可以直接通过对应协议启动下载器，无需使用本地服务器

* **注册/更新协议（仅需一次）**

无需管理员权限，自动检测Node.js路径及下载器路径

```bash
npm run registerUrlProtocol
```

调用方式
在浏览器或本地直接打开协议链接即可

```text
m3u8mimic://<Base64(JSON Payload)>
```

例如：

```text
m3u8mimic://eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tL3RhcmdldC5tM3U4Iiwic2F2ZU5hbWUiOiLop4bpopHkv53lrZjlkI3np7AiLCJ3b3JrRGlyIjoiRDovbTN1OCIsImhlYWRlcnMiOnsiUmVmZXJlciI6Imh0dHBzOi8vZXhhbXBsZS5jb20ifX0=
```

卸载协议：

```bash
npm run unregisterUrlProtocol
```

---

### 模式三：CLI 命令行

直接在CLI中通过`--`传递参数
(--headers必须为标准JSON)

```bash
node src/bin/worker.ts --url "https://example.com/target.m3u8" --saveName "视频保存名称" --workDir "D:/m3u8" --headers "{\"Referer\":\"https://example.com/\"}'
```

---

## 后记

本项目在部分设计方面参考了`N_m3u8DL-CLI`项目

### TODO

* [ ] SAMPLE-AES解密 （不含DRM）
* [ ] 解析本地m3u8
* [ ] 前端GUI

---

## 📄 开源协议

本项目基于 **MIT License** 开源
