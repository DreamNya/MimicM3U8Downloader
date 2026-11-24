import { config } from "#src/common/cli.ts";

export function getSegmentFailureLimit(segmentCount: number): number | undefined {
    if (!config.skipFailedSegments) {
        return undefined;
    }
    const limit = config.maxFailedSegments;
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
