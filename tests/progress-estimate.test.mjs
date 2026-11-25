import { logger } from "#src/common/logger.ts";
import { progressTracker } from "#src/core/progressTracker.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("resumed progress estimates size using completed segments only", (t) => {
    const print = t.mock.method(logger, "print", () => {});
    const mib = 1024 * 1024;
    progressTracker.start(862, {
        completedBeforeRun: 83,
        bytesBeforeRun: Math.round(287.51 * mib),
        failedBeforeRun: 0,
    });
    t.after(() => progressTracker.stop());

    progressTracker.print();
    assert.match(print.mock.calls.at(-1).arguments[0], /83\/862 .* -- 287\.51 MB\/2\.92 GB /);

    for (const fileName of ["000083.ts", "000084.ts", "000085.ts"]) {
        progressTracker.recordChunk(2 * mib);
        progressTracker.recordSegmentDownloaded(fileName, 2 * mib);
    }

    const partialBytes = Math.round(2.79 * mib);
    progressTracker.recordChunk(partialBytes);
    progressTracker.print();
    assert.match(print.mock.calls.at(-1).arguments[0], /83\+3\/862 .* -- 296\.3 MB\/2\.87 GB /);

    progressTracker.rollbackBytes(partialBytes);
    progressTracker.print();
    assert.match(print.mock.calls.at(-1).arguments[0], /83\+3\/862 .* -- 293\.51 MB\/2\.87 GB /);
});
