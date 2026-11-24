import { config } from "#src/common/cli.ts";
import { Impit, type ImpitResponse, type RequestInit } from "impit";
import { addAbortListener } from "node:events";

const READ_CLOCK_INTERVAL = Math.min(1_000, Math.max(1, Math.floor(config.timeout / 10)));

interface ReadClockSample {
    end?: number;
}

let readClockSample: ReadClockSample = {};
let readClockTimer: NodeJS.Timeout | undefined;
let activeBodies = 0;

function advanceReadClock(now = performance.now()): number {
    readClockSample.end = now;
    readClockSample = {};
    return now;
}

function retainReadClock(): () => void {
    if (activeBodies++ === 0) {
        readClockTimer = setInterval(advanceReadClock, READ_CLOCK_INTERVAL).unref();
    }
    return () => {
        if (--activeBodies === 0) {
            clearInterval(readClockTimer);
            readClockTimer = undefined;
        }
    };
}

export const impit = new Impit({
    browser: config.browser,
    proxyUrl: config.proxyUrl || undefined,
    ignoreTlsErrors: true,
    timeout: config.timeout,
    headers: config.headers,
});

export async function fetchSegment(url: string, headers: RequestInit["headers"], signal?: AbortSignal) {
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => {
        controller.abort(new Error(`等待分片响应头超时（${config.timeout} 毫秒）`));
    }, config.timeout);

    try {
        const response = await impit.fetch(url, {
            headers,
            signal: requestSignal,
            // 收到响应头前取消 JS 层的等待后，底层请求由总超时回收。
            timeout: Math.max(config.timeout, config.totalTimeout),
        });
        const body = response.body;
        if (!response.ok || requestSignal.aborted) {
            void body?.cancel().catch(() => void 0);
            requestSignal.throwIfAborted();
            return { response, body: null };
        }
        return { response, body: body ? limitSegmentReadTime(body, controller, requestSignal) : null };
    } finally {
        clearTimeout(timer);
    }
}

function limitSegmentReadTime(body: ImpitResponse["body"], controller: AbortController, signal: AbortSignal) {
    const reader = body.getReader();
    const releaseReadClock = retainReadClock();
    let closed = false;
    let abortListener: ReturnType<typeof addAbortListener>;
    let pendingRead: ReadClockSample | undefined;
    let readTimer: NodeJS.Timeout | undefined;

    const checkReadTimeout = () => {
        readTimer = undefined;
        if (!pendingRead) {
            return;
        }

        const now = performance.now();
        // 用读取开始后的首个采样作为时间上界，采样即使延迟也不会提前判定超时。
        const startedBy = pendingRead.end ?? advanceReadClock(now);
        const remaining = config.timeout - (now - startedBy);
        if (remaining > 0) {
            readTimer = setTimeout(checkReadTimeout, Math.ceil(remaining));
        } else {
            controller.abort(new Error(`分片响应体连续 ${config.timeout} 毫秒未收到数据`));
        }
    };

    const release = () => {
        closed = true;
        pendingRead = undefined;
        clearTimeout(readTimer);
        releaseReadClock();
        abortListener[Symbol.dispose]();
        reader.releaseLock();
    };

    const cancel = (reason: unknown) => {
        const cancellation = reader.cancel(reason);
        release();
        return cancellation;
    };

    return new ReadableStream<Uint8Array>(
        {
            start(stream) {
                abortListener = addAbortListener(signal, () => {
                    stream.error(signal.reason);
                    void cancel(signal.reason).catch(() => void 0);
                });
            },
            async pull(stream) {
                pendingRead = readClockSample;
                readTimer ??= setTimeout(checkReadTimeout, config.timeout);

                try {
                    const { done, value } = await reader.read();
                    if (closed) {
                        return;
                    }
                    if (done) {
                        release();
                        stream.close();
                    } else {
                        stream.enqueue(value);
                    }
                } catch (err) {
                    if (!closed) {
                        release();
                        stream.error(err);
                    }
                } finally {
                    pendingRead = undefined;
                }
            },
            cancel,
        },
        // 仅在下游请求下一块时计时，避免把磁盘或解密流的背压算进网络超时。
        { highWaterMark: 0 }
    );
}
