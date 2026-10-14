import { saveJson, storageOf } from "./browser-storage";

/**
 * One-shot exemplar hand-off from the Metrics page to the Traces page. A metric's
 * Trace link stashes the trace to open (and the shard it was recorded on) here;
 * the Traces panel reads and clears it on mount and pre-filters to that trace on
 * that shard. A sessionStorage hand-off — rather than a router search param —
 * keeps the two panels decoupled from the traces route's (schema-less) search.
 *
 * A sibling of {@link file://./shard-history.ts}: a domain-specific session hand-off
 * built on the guarded {@link file://./browser-storage.ts} accessors, so a
 * missing/throwing store (SSR, privacy mode) degrades to "no hand-off" in one place.
 */
const STORAGE_KEY = "lunora:traces:pending-filter";

/** The hand-off payload: the trace to open, plus the shard it was recorded on so Traces queries the right ring. */
export interface PendingTraceFilter {
    shardKey?: string;
    traceId: string;
}

/** Stash a one-shot exemplar hand-off for the Traces panel. Call from an event, never render; a blocked store is a silent no-op. */
export const writePendingTraceFilter = (filter: PendingTraceFilter): void => {
    saveJson(STORAGE_KEY, filter, "session");
};

/**
 * Peek at the one-shot exemplar hand-off WITHOUT consuming it, or `undefined` when
 * there is none. Pure — it never mutates the store — so it is safe to call from a
 * render / lazy state initializer (and a double-invoked initializer under React
 * StrictMode is harmless). It is SSR-guarded (a missing store yields `undefined`).
 * A malformed payload (or a blocked store) is treated as absent, and each field is
 * type-checked so a tampered non-string can't reach the panel (a numeric `shardKey`
 * would crash the panel's `shardKey.trim()`). Pair with {@link clearPendingTraceFilter}
 * in a mount effect to consume it one-shot.
 */
export const peekPendingTraceFilter = (): PendingTraceFilter | undefined => {
    const storage = storageOf("session");

    if (storage === undefined) {
        return undefined;
    }

    try {
        const raw = storage.getItem(STORAGE_KEY);

        if (raw === null) {
            return undefined;
        }

        const parsed = JSON.parse(raw) as Partial<PendingTraceFilter>;

        if (typeof parsed.traceId !== "string") {
            return undefined;
        }

        return { traceId: parsed.traceId, ...(typeof parsed.shardKey === "string" ? { shardKey: parsed.shardKey } : {}) };
    } catch {
        return undefined;
    }
};

/**
 * Consume the one-shot hand-off by clearing it, so a later manual visit isn't
 * re-filtered. Call from a committed boundary (a mount effect), never render — the
 * store mutation must not run during rendering. A missing/blocked store is a silent
 * no-op, as is clearing when there was nothing to clear.
 */
export const clearPendingTraceFilter = (): void => {
    try {
        storageOf("session")?.removeItem(STORAGE_KEY);
    } catch {
        // Blocked store (SSR, privacy mode) — nothing to consume.
    }
};
