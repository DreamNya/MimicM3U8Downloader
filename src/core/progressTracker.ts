import { logger } from "#src/common/logger.ts";
import { formatBytes, formatTime } from "#src/common/utils.ts";

type RecordType = "success" | "failed" | "cache";

interface StreamProgress {
    completedBeforeRun: number;
    bytesBeforeRun: number;
    failedBeforeRun: number;
}

class ProgressTracker {
    #totalCount?: number;
    #streamProgress?: StreamProgress & { writtenThisRun: number };
    #downloadedBytes = 0;
    #completedSegmentBytes = 0;
    #lastBytes = 0;
    #currentSpeed = 0;
    #timer: NodeJS.Timeout | null = null;

    #sets: Record<RecordType, Set<string>> = {
        success: new Set(),
        failed: new Set(),
        cache: new Set(),
    };

    start(totalCount: number, streamProgress?: StreamProgress): void {
        this.#totalCount = totalCount;
        this.#streamProgress = streamProgress && { ...streamProgress, writtenThisRun: 0 };
        this.#lastBytes = this.#downloadedBytes;
        this.#timer = setInterval(() => {
            const deltaBytes = this.#downloadedBytes - this.#lastBytes;
            this.#currentSpeed = Math.max(0, deltaBytes);
            this.#lastBytes = this.#downloadedBytes;
            this.print();
        }, 1000);
    }

    recordStreamSegmentWritten(): void {
        if (this.#streamProgress) {
            this.#streamProgress.writtenThisRun++;
            this.print();
        }
    }

    stop(): void {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
            this.#totalCount = undefined;
            logger.endProgress();
        }
    }

    recordChunk(chunkLength: number): void {
        this.#downloadedBytes += chunkLength;
    }

    rollbackBytes(bytes: number): void {
        this.#downloadedBytes -= bytes;
    }

    getDownloadedBytes(): number {
        return this.#downloadedBytes;
    }

    recordSegmentDownloaded(fileName: string, bytes: number): void {
        if (!this.#sets.success.has(fileName)) {
            this.#sets.success.add(fileName);
            this.#completedSegmentBytes += bytes;
        }
    }

    add(type: Exclude<RecordType, "success">, value: string): void {
        this.#sets[type].add(value);
    }

    delete(type: Exclude<RecordType, "success">, value: string): boolean {
        return this.#sets[type].delete(value);
    }

    has(type: RecordType, value: string): boolean {
        return this.#sets[type].has(value);
    }

    get(type: RecordType): ReadonlySet<string> {
        return this.#sets[type];
    }

    size(type: RecordType): number {
        return this.#sets[type].size;
    }

    print(): void {
        if (!this.#totalCount) {
            return;
        }
        const completedThisRun = this.size("success");
        const completedBeforeRun = this.#streamProgress?.completedBeforeRun ?? 0;
        const completedCount = completedBeforeRun + completedThisRun;
        if (completedCount === 0) {
            return;
        }

        const pendingMergeCount = this.#streamProgress ? completedThisRun - this.#streamProgress.writtenThisRun : 0;
        const completedStr =
            pendingMergeCount > 0 ? `${completedCount - pendingMergeCount}+${pendingMergeCount}` : completedCount;
        const failedCount = (this.#streamProgress?.failedBeforeRun ?? 0) + this.size("failed");
        const failedStr = failedCount ? `-${failedCount}` : "";
        const bytesBeforeRun = this.#streamProgress?.bytesBeforeRun ?? 0;
        const completedBytes = bytesBeforeRun + this.#completedSegmentBytes;
        const downloadedBytes = Math.max(completedBytes, bytesBeforeRun + this.#downloadedBytes);
        const downloadedSizeStr = formatBytes(downloadedBytes);
        const sampledSegmentCount = completedThisRun + (bytesBeforeRun > 0 ? completedBeforeRun : 0);
        // 流式合并已确认跳过的分片不计入大小预估。
        const remainingSegmentCount = this.#totalCount - completedCount - (this.#streamProgress ? failedCount : 0);
        const totalSize =
            sampledSegmentCount > 0
                ? Math.max(downloadedBytes, completedBytes + (completedBytes / sampledSegmentCount) * remainingSegmentCount)
                : undefined;
        const totalSizeStr = totalSize === undefined ? "" : `/${formatBytes(totalSize)}`;
        const percent = ((completedCount / this.#totalCount) * 100).toFixed(2);
        const currentSpeedStr = `${formatBytes(this.#currentSpeed)}/s`;
        const timeStr =
            this.#currentSpeed > 0 && totalSize !== undefined
                ? ` @ ${formatTime(Math.max(0, totalSize - downloadedBytes) / this.#currentSpeed)}`
                : "";

        logger.print(
            `下载进度: ${completedStr}/${this.#totalCount}${failedStr} (${percent}%) -- ${downloadedSizeStr}${totalSizeStr} (${currentSpeedStr}${timeStr})`
        );
    }
}

export const progressTracker = new ProgressTracker();
