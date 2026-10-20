import { LunoraError } from "@lunora/errors";

import { withinRpcDeadline } from "./rpc-deadline";

/**
 * Read the next chunk, or fail with `STREAM_IDLE` when nothing arrives within `idleMs`.
 *
 * A body that stops delivering without closing (a proxy that swallows the FIN, a
 * server that died mid-stream) otherwise leaves `reader.read()` pending forever,
 * and with it the stream that never reconnects. `read` is one read of that
 * body — a stream reader's `read()`, or a body-less Response's whole-payload
 * `text()` — and the caller owns what it reads: on `STREAM_IDLE` it must release
 * it. `idleMs <= 0` reads without a bound.
 */
const readOrIdle = async <T>(read: () => Promise<T>, idleMs: number): Promise<T> => {
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
        return read();
    }

    return withinRpcDeadline(
        idleMs,
        undefined,
        async () => read(),
        () => new LunoraError("STREAM_IDLE", `stream received nothing for ${idleMs.toString()}ms`),
    );
};

export default readOrIdle;
