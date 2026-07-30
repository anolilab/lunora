/**
 * Pure helpers for resolving a dispatch's trace context and classifying span
 * errors.
 *
 * Split out of `shard-do.ts` for the same reason `parseLogArgs`/`isLogFields`
 * were: these are module-level, `this`-free functions, and that file is already
 * ~8.5k lines. Keeping them here makes them directly unit-testable and keeps the
 * shard class to code that actually needs its state.
 */
import { isLunoraError } from "@lunora/errors";

import { otlpRandomHex, parseTraceparent } from "../../../shared/otlp";

/**
 * The trace ids a dispatch's spans hang off: taken from the inbound
 * `traceparent` when the runtime forwarded one (so the shard's spans join the
 * worker's trace and any container's beneath it), else freshly minted so a
 * dispatch with no inbound context — a subscription re-run, a server-initiated
 * call — still produces a coherent, self-contained local trace.
 */
export const resolveTraceAnchor = (traceparent: string | undefined): { rootSpanId: string; sampled: boolean; traceId: string } => {
    const inbound = parseTraceparent(traceparent);

    return {
        rootSpanId: inbound?.parentSpanId ?? otlpRandomHex(8),
        // Honour the upstream verdict. An unsampled inbound trace stays unsampled
        // through the shard and out to whatever the handler calls, which is the
        // whole point of the bit — deciding again downstream produces a trace the
        // collector holds only the middle of. Absent a `traceparent` there is no
        // verdict to honour and the shard is the trace root, so it samples.
        sampled: inbound?.sampled ?? true,
        traceId: inbound?.traceId ?? otlpRandomHex(16),
    };
};

/**
 * Classify a thrown value for a span's `error.type`. Prefers a `LunoraError`'s
 * stable `code` so spans group by the same taxonomy the RPC spans use
 * (`error.type` there is the catalog code), falling back to the constructor name
 * and finally to the OTel-conventional `"Error"` for a non-Error throw.
 */
export const toErrorType = (error: unknown): string => {
    if (isLunoraError(error)) {
        return error.code;
    }

    return error instanceof Error ? error.constructor.name : "Error";
};
