import { logger } from "#src/common/logger.ts";
import { formatBytes, formatTime } from "#src/common/utils.ts";

type RecordType = "success" | "failed" | "cache";

interface StreamProgress {
    completedBeforeRun: number;
    skippedCount: number;
}

class ProgressTracker {
    #totalCount?: number;
    #streamProgress?: StreamProgress;
    #downloadedBytes = 0;
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
        this.#streamProgress = streamProgress;
        this.#lastBytes = this.#downloadedBytes;
        this.#timer = setInterval(() => {
            const deltaBytes = this.#downloadedBytes - this.#lastBytes;
            this.#currentSpeed = Math.max(0, deltaBytes);
            this.#lastBytes = this.#downloadedBytes;
            this.print();
        }, 1000);
    }

    setSkippedCount(count: number): void {
        if (this.#streamProgress) this.#streamProgress.skippedCount = count;
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

    add(type: RecordType, value: string): void {
        this.#sets[type].add(value);
    }

    delete(type: RecordType, value: string): boolean {
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

        const failedCount = this.size("failed");
        const failedStr = failedCount ? `-${failedCount}` : "";
        const skippedCount = this.#streamProgress?.skippedCount ?? 0;
        const skippedStr = skippedCount ? `，已跳过 ${skippedCount} 片` : "";
        const downloadedSizeStr = formatBytes(this.#downloadedBytes);
        const totalSize =
            completedThisRun > 0
                ? (this.#downloadedBytes / completedThisRun) * (this.#totalCount - completedBeforeRun - skippedCount)
                : undefined;
        const totalSizeStr = totalSize === undefined ? "" : `/${formatBytes(totalSize)}`;
        const percent = ((completedCount / this.#totalCount) * 100).toFixed(2);
        const currentSpeedStr = `${formatBytes(this.#currentSpeed)}/s`;
        const timeStr =
            this.#currentSpeed > 0 && totalSize !== undefined
                ? ` @ ${formatTime(Math.max(0, totalSize - this.#downloadedBytes) / this.#currentSpeed)}`
                : "";

        logger.print(
            `下载进度: ${completedCount}/${this.#totalCount}${failedStr} (${percent}%)${skippedStr} -- ${downloadedSizeStr}${totalSizeStr} (${currentSpeedStr}${timeStr})`
        );
    }
}

export const progressTracker = new ProgressTracker();
