import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSegmentsByRange } from "#src/core/segment/filter.ts";

const segments = [1.5, 2.25, 0.75, 3.5, 1].map((duration, index) => ({
    duration,
    index,
    url: `https://example.test/${index}.ts`,
}));

for (const [range, expected] of [
    ["", [0, 1, 2, 3, 4]],
    ["1-2", [1, 2]],
    ["-1", [0, 1]],
    ["3-", [3, 4]],
    ["4, 1-2, 2-3, 1", [1, 2, 3, 4]],
    ["10-", []],
    ["00:00:01.5-00:00:04.5", [1, 2]],
    ["-00:00:01.5", [0]],
    ["00:00:04.5-", [3, 4]],
    ["00:00:03.75", [2]],
    ["00:00:09", []],
    ["00:00:04-00:00:08,00:00:03-00:00:05", [1, 2, 3]],
]) {
    test(`range ${JSON.stringify(range)} selects segments in playlist order`, () => {
        assert.deepEqual(
            filterSegmentsByRange(range, segments),
            expected.map((index) => segments[index])
        );
    });
}

for (const range of ["2abc", "00::02", "00:00:60", "1,00:00:02", "1-2-3", "3-1", "-"]) {
    test(`range ${JSON.stringify(range)} is rejected`, () => {
        assert.throws(() => filterSegmentsByRange(range, segments), /不合法的/);
    });
}
