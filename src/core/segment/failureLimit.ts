import type { DownloadOptions } from "#src/common/types.ts";

export function getSegmentFailureLimit(
    segmentCount: number,
    { skipFailedSegments, maxFailedSegments: limit }: Pick<DownloadOptions, "skipFailedSegments" | "maxFailedSegments">
): number | undefined {
    if (!skipFailedSegments) {
        return undefined;
    }
    if (typeof limit === "number") {
        return limit < 1 ? Infinity : limit;
    }
    const [whole, fractional = ""] = limit.slice(0, -1).split(".");
    const divisor = 10n ** BigInt(fractional.length + 2);
    return Number((BigInt(segmentCount) * BigInt(whole + fractional)) / divisor);
}

export function segmentFailureLimitError(limit: number, cause?: unknown): Error {
    return new Error(`失败分片数量超过允许跳过的上限（${limit} 片）`, { cause });
}
