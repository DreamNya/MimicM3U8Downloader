import type { Browser } from "impit";

export interface DownloadTarget {
    /** m3u8 请求地址 */
    url: string;
    /** 视频存储文件名（不包括后缀） */
    saveName: string;
    /** 视频存储目录（临时文件也会存储在该目录下） */
    workDir: string;
}

export interface DownloadOptions {
    /**
     * 模拟 TLS 指纹浏览器名称
     * * 详见<https://apify.github.io/impit/js/types/Browser.html>
     * @default 'chrome'
     */
    browser: Browser;
    /**
     * 代理服务器地址
     * @default undefined
     */
    proxyUrl: string;
    /**
     * 请求头
     * * 同时用于请求m3u8文件及分片
     * @default {}
     */
    headers: Record<string, string>;
    /**
     * 分片选择范围
     * @default ''
     */
    range: string;
    /**
     * 分片迸发请求数
     * @default 16
     */
    concurrency: number;
    /**
     * 网络请求失败时自动重试次数
     * * `403` / `404`时不会重试
     * @default 3
     */
    maxRetries: number;
    /**
     * 网络请求的超时毫秒
     * * 包含请求及连接时间，如果分片过大建议提高超时时间
     * @default 60000
     */
    timeout: number;
    /**
     * 流式合并
     * * 下载分片后直接在内存中流式合并
     * * ℹ️ 可减少≈50%磁盘写入量
     * * 🚨 不支持断点续传，对网络稳定性要求较高
     * * ⚠️ 最多额外占用 [迸发数*分片平均大小] 内存
     * * ⚠️ 如果为 true 则忽略: noMerge, forceMerge
     * @default false
     */
    streamMerge: boolean;
    /**
     * 分片下载完毕不自动合并
     * * ⚠️ 如果为 true 则忽略: forceMerge
     * @default false
     */
    noMerge: boolean;
    /**
     * 分片下载不完整时强制合并
     * @default false
     */
    forceMerge: boolean;
    /**
     * 下载完毕后删除临时文件夹
     * @default false
     */
    enableDelAfterDone: boolean;
    /**
     * 下载完毕后暂停交互窗口
     * @default true
     */
    pauseAfterDone: boolean;
    /**
     * 记录debug中间产物
     * @default false
     */
    debug: boolean;
}

export interface DownloadWorkspace {
    tempDir: string;
    tsDir: string;
    outputFile: string;
}

export type DownloadInputConfig = DownloadTarget & DownloadOptions;
export type DownloadRuntimeConfig = DownloadInputConfig & DownloadWorkspace;
export type UserPayload = DownloadTarget & Partial<DownloadOptions>;
