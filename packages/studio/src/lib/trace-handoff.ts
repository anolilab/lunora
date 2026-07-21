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
 * Read and clear the one-shot exemplar hand-off, or `null` when there is none.
 * Call from an effect (never render) — it touches `sessionStorage`. A malformed
 * payload (or a blocked store) is treated as absent, and each field is type-checked
 * so a tampered non-string can't reach the panel (a numeric `shardKey` would crash
 * the panel's `shardKey.trim()`).
 */
export const readPendingTraceFilter = (): PendingTraceFilter | null => {
    const storage = storageOf("session");

    if (storage === undefined) {
        return null;
    }

    try {
        const raw = storage.getItem(STORAGE_KEY);

        if (raw === null) {
            return null;
        }

        // One-shot: clear before returning so a later manual visit isn't re-filtered.
        storage.removeItem(STORAGE_KEY);

        const parsed = JSON.parse(raw) as Partial<PendingTraceFilter>;

        if (typeof parsed.traceId !== "string") {
            return null;
        }

        return { traceId: parsed.traceId, ...(typeof parsed.shardKey === "string" ? { shardKey: parsed.shardKey } : {}) };
    } catch {
        return null;
    }
};
