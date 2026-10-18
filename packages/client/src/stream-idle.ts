import { LunoraError } from "@lunora/errors";

/**
 * Read the next chunk, or fail with `STREAM_IDLE` when nothing arrives within `idleMs`.
 *
 * A body that stops delivering without closing (a proxy that swallows the FIN, a
 * server that died mid-stream) otherwise leaves `reader.read()` pending forever,
 * and with it the stream that never reconnects. The caller owns the reader: on
 * `STREAM_IDLE` it must cancel it. `idleMs <= 0` reads without a bound.
 */
const readOrIdle = async <T>(reader: ReadableStreamDefaultReader<T>, idleMs: number): Promise<ReadableStreamReadResult<T>> => {
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
        return reader.read();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new LunoraError("STREAM_IDLE", `stream received nothing for ${idleMs.toString()}ms`));
        }, idleMs);
    });

    try {
        return await Promise.race([reader.read(), idle]);
    } finally {
        clearTimeout(timer);
    }
};

export default readOrIdle;
