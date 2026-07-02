import { logger } from "#src/common/logger.ts";
import { formatBytes, formatTime } from "#src/common/utils.ts";

type RecordType = "success" | "failed" | "cache";

class ProgressTracker {
    #totalCount!: number;
    #downloadedBytes = 0;
    #lastBytes = 0;
    #currentSpeed = 0;
    #timer: NodeJS.Timeout | null = null;

    #sets: Record<RecordType, Set<string>> = {
        success: new Set(),
        failed: new Set(),
        cache: new Set(),
    };

    start(totalCount: number): void {
        this.#totalCount = totalCount;
        this.#lastBytes = this.#downloadedBytes;
        this.#timer = setInterval(() => {
            const deltaBytes = this.#downloadedBytes - this.#lastBytes;
            this.#currentSpeed = Math.max(0, deltaBytes);
            this.#lastBytes = this.#downloadedBytes;
            this.print();
        }, 1000);
    }

    stop(): void {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
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
        const completedCount = this.size("success");
        if (completedCount === 0) {
            return;
        }

        const failedCount = this.size("failed");
        const failedStr = failedCount ? `-${failedCount}` : "";
        const downloadedSizeStr = formatBytes(this.#downloadedBytes);
        const totalSize = (this.#downloadedBytes / completedCount) * this.#totalCount;
        const totalSizeStr = formatBytes(totalSize);
        const percent = ((completedCount / this.#totalCount) * 100).toFixed(2);
        const currentSpeedStr = `${formatBytes(this.#currentSpeed)}/s`;
        const timeStr =
            this.#currentSpeed > 0 ? ` @ ${formatTime((totalSize - this.#downloadedBytes) / this.#currentSpeed)}` : "";

        logger.print(
            `下载进度: ${completedCount}/${this.#totalCount}${failedStr} (${percent}%) -- ${downloadedSizeStr}/${totalSizeStr} (${currentSpeedStr}${timeStr})`
        );
    }
}

export const progressTracker = new ProgressTracker();
