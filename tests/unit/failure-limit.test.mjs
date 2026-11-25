import assert from "node:assert/strict";
import { test } from "node:test";
import { getSegmentFailureLimit } from "#src/core/segment/failureLimit.ts";

for (const { name, segmentCount, skipFailedSegments = true, maxFailedSegments, expected } of [
    { name: "skipping is disabled", segmentCount: 10, skipFailedSegments: false, maxFailedSegments: 3, expected: undefined },
    { name: "numeric zero is unlimited", segmentCount: 10, maxFailedSegments: 0, expected: Infinity },
    { name: "a numeric fraction is unlimited", segmentCount: 10, maxFailedSegments: 0.5, expected: Infinity },
    { name: "an integer is an absolute limit", segmentCount: 10, maxFailedSegments: 3, expected: 3 },
    { name: "zero percent allows no skips", segmentCount: 10, maxFailedSegments: "0%", expected: 0 },
    { name: "a fractional percentage rounds down", segmentCount: 40, maxFailedSegments: "7.25%", expected: 2 },
    { name: "a percentage exactly at an integer stays exact", segmentCount: 100, maxFailedSegments: "29%", expected: 29 },
]) {
    test(name, () => {
        assert.equal(getSegmentFailureLimit(segmentCount, { skipFailedSegments, maxFailedSegments }), expected);
    });
}
