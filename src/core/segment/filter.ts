import type { Segment } from "#src/core/m3u8Parser.ts";

/**
 * 根据配置的 range 规则过滤分片列表
 */
export function filterSegmentsByRange(rangeStr: string, segments: Segment[]): Segment[] {
    if (!rangeStr) {
        return segments;
    }
    const isTimeRange = rangeStr.includes(":");

    // 1. 时间轴格式解析 (如 "00:00:28-00:10:00")
    if (isTimeRange) {
        const timeToSeconds = (timeStr: string): number => {
            const parts = timeStr.split(":").map(Number);
            if (parts.length !== 3 || parts.some(isNaN)) {
                throw new Error(`不合法的时间格式: "${timeStr}"，期待格式为 "HH:MM:SS"`);
            }
            return parts.reduce((acc, val) => acc * 60 + val, 0);
        };

        const parts = rangeStr.split(",");
        const timeRanges: { start: number; end: number }[] = [];

        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) {
                continue;
            }

            if (trimmed.includes("-")) {
                const [startStr, endStr] = trimmed.split("-");
                const start = startStr.trim() ? timeToSeconds(startStr.trim()) : 0;
                const end = endStr.trim() ? timeToSeconds(endStr.trim()) : Infinity;
                timeRanges.push({ start, end });
            } else {
                const time = timeToSeconds(trimmed);
                timeRanges.push({ start: time, end: time });
            }
        }

        let currentRefTime = 0;
        const filtered: Segment[] = [];

        for (const seg of segments) {
            const startTime = currentRefTime;
            const endTime = currentRefTime + seg.duration;
            currentRefTime = endTime; // 递增时间指针

            const matches = timeRanges.some((range) => {
                if (range.start === range.end) {
                    return startTime <= range.start && range.start < endTime;
                }
                // 分片起点小于范围终点 且 分片终点大于范围起点
                return startTime < range.end && endTime > range.start;
            });

            if (matches) {
                filtered.push(seg);
            }
        }

        return filtered;
    }
    // 精确分片索引格式解析 (如 "110,120-130")
    else {
        const parts = rangeStr.split(",");
        const exactIndices = new Set<number>();
        const indexRanges: { start: number; end: number }[] = [];

        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) {
                continue;
            }

            if (trimmed.includes("-")) {
                const [startStr, endStr] = trimmed.split("-");
                const start = startStr && startStr.trim() ? parseInt(startStr.trim(), 10) : 0;
                const end = endStr && endStr.trim() ? parseInt(endStr.trim(), 10) : Infinity;
                indexRanges.push({ start, end });
            } else {
                exactIndices.add(parseInt(trimmed, 10));
            }
        }

        return segments.filter((seg) => {
            if (exactIndices.has(seg.index)) {
                return true;
            }
            return indexRanges.some((range) => seg.index >= range.start && seg.index <= range.end);
        });
    }
}
