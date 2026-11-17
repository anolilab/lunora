import type { UsageEvent } from "./types";

/**
 * `reportRetryAt` of a row the usage sweep must never forward: a `"set"` marker or a non-positive
 * quantity. A real value rather than an absent one, so the sweep's indexed `reportRetryAt <= now`
 * read leaves the row behind instead of re-reading it on every sweep.
 */
export const USAGE_NEVER_DUE: number = Number.MAX_SAFE_INTEGER;

/** When a newly recorded row first becomes due for the sweep. */
export const usageFirstDueAt = (event: Pick<UsageEvent, "createdAt" | "mode" | "quantity">): number =>
    event.mode !== "set" && event.quantity > 0 ? event.createdAt : USAGE_NEVER_DUE;
