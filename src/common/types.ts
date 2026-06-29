import type { Browser } from "impit";

export interface DownloadTarget {
    // m3u8 请求地址
    url: string;
    // 视频存储文件名（不包括后缀）
    saveName: string;
    // 视频存储目录（临时文件也会存储在该目录下）
    workDir: string;
}

export interface DownloadOptions {
    // 模拟 TLS 指纹浏览器名称(https://apify.github.io/impit/js/types/Browser.html) (Default: chrome)
    browser: Browser;
    // 代理服务器地址 (Default: undefined)
    proxyUrl?: string;
    // 分片迸发请求数 (Default: 16)
    concurrency: number;
    // 网络请求失败时自动重试次数（403 404时不会重试） (Default: 3)
    maxRetries: number;
    // 网络请求的超时毫秒（包含请求及连接时间，如果分片过大建议提高超时时间） (Default: 60000)
    timeout: number;
    // 下载完毕后删除临时文件夹 (Default: false)
    enableDelAfterDone: boolean;
    // 分片下载完毕不自动合并 (Default: false)
    noMerge: boolean;
    // 分片下载不完整时强制合并 (Default: false)
    forceMerge: boolean;
    // 请求头（同时用于请求m3u8文件及分片） (Default: {})
    headers: Record<string, string>;
    // 下载完毕后暂停交互窗口 (Default:true)
    pauseAfterDone: boolean;
}

export type DownloadRuntimeConfig = DownloadTarget & DownloadOptions;
export type UserPayload = DownloadTarget & Partial<DownloadOptions>;

export interface Segment {
    url: string;
    duration: number;
}
