import { formatBytes, formatTime } from "#src/common/utils.ts";
import { logger } from "#src/common/logger.ts";

class ProgressTracker {
    #totalCount!: number;
    #downloadedBytes = 0;
    #lastBytes = 0;
    #currentSpeed = 0;
    #timer: NodeJS.Timeout | null = null;

    #downloadedSet = new Set<string>();
    #failedSet = new Set<string>();

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

    recordSuccess(fileName: string): void {
        this.#downloadedSet.add(fileName);
    }

    recordFailed(errorMsg: string): void {
        this.#failedSet.add(errorMsg);
    }

    getDownloadedCount(): number {
        return this.#downloadedSet.size;
    }

    getDownloadedBytes(): number {
        return this.#downloadedBytes;
    }

    getDownloadedSet(): ReadonlySet<string> {
        return this.#downloadedSet;
    }

    getFailedSet(): ReadonlySet<string> {
        return this.#failedSet;
    }

    print(): void {
        const completedCount = this.#downloadedSet.size;
        if (completedCount === 0) {
            return;
        }

        const failedCount = this.#failedSet.size;
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
