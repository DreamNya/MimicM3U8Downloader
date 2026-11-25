import type { Segment } from "#src/core/m3u8Parser.ts";

function parseIndex(input: string): number {
    const index = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(index)) {
        throw new Error(`不合法的分片索引: "${input}"`);
    }
    return index;
}

function parseTime(input: string): number {
    const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(input);
    if (match) {
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);
        const total = hours * 3600 + minutes * 60 + seconds;
        if (minutes < 60 && seconds < 60 && total <= Number.MAX_SAFE_INTEGER) {
            return total;
        }
    }
    throw new Error(`不合法的时间格式: "${input}"，期待格式为 "HH:MM:SS"`);
}

/**
 * 根据配置的 range 规则过滤分片列表
 */
export function filterSegmentsByRange(rangeStr: string, segments: Segment[]): Segment[] {
    if (!rangeStr) {
        return segments;
    }

    const isTimeRange = rangeStr.includes(":");
    const parsePosition = isTimeRange ? parseTime : parseIndex;
    const ranges = rangeStr
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const [first, last, ...extra] = part.split("-").map((end) => end.trim());
            if (last === undefined) {
                const position = parsePosition(first);
                return { start: position, end: position };
            }

            const start = first ? parsePosition(first) : 0;
            const end = last ? parsePosition(last) : Infinity;
            if (extra.length || (!first && !last) || start > end) {
                throw new Error(`不合法的分片范围: "${part}"`);
            }
            return { start, end };
        });

    if (isTimeRange) {
        let position = 0;
        return segments.filter((segment) => {
            const start = position;
            position += segment.duration;
            return ranges.some((range) => {
                // 单点归入起点包含、终点排除的分片，其余范围按时间重叠选取。
                if (range.start === range.end) {
                    return start <= range.start && range.start < position;
                }
                return start < range.end && position > range.start;
            });
        });
    }

    const exactIndices = new Set<number>();
    const indexRanges: typeof ranges = [];
    for (const range of ranges) {
        if (range.start === range.end) {
            exactIndices.add(range.start);
        } else {
            indexRanges.push(range);
        }
    }
    return segments.filter(
        ({ index }) => exactIndices.has(index) || indexRanges.some(({ start, end }) => start <= index && index <= end)
    );
}
