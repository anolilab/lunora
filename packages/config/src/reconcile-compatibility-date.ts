/**
 * Auto-bump `compatibility_date` in `wrangler.jsonc` when Workers Cache is
 * enabled but the date is too low. Mirrors the reconciler pattern used for
 * bindings and crons: structural edit via `jsonc-parser`, preserving comments
 * and formatting.
 *
 * Only bumps the date — never lowers it. Idempotent: if the date already meets
 * the requirement, nothing is written.
 */
import { writeFileSync } from "node:fs";

import { applyEdits, modify } from "jsonc-parser";

import { FORMATTING } from "./jsonc-edit";
import { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "./workers-cache";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

export interface ReconcileCompatibilityDateResult {
    /** `true` when `wrangler.jsonc` was rewritten. */
    changed: boolean;
    /** The new date value, or the existing one when unchanged. */
    date: string | undefined;
    /** Human-readable reason when reconciliation was skipped. */
    reason?: string;
    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

/**
 * Reconcile the `compatibility_date` in `wrangler.jsonc` when Workers Cache
 * is enabled but the date is below the minimum required.
 */
export const reconcileWranglerCompatibilityDate = (projectRoot: string): ReconcileCompatibilityDateResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (!wranglerPath) {
        return { changed: false, date: undefined, reason: "wrangler.jsonc not found" };
    }

    const { parsed, text } = readWranglerJsonc<{
        cache?: { enabled?: boolean } | null;
        compatibility_date?: string;
        exports?: Record<string, { cache?: { enabled?: boolean } | null } | null> | null;
    }>(wranglerPath);

    if (parsed === undefined) {
        return { changed: false, date: undefined, reason: `failed to parse ${wranglerPath} as JSONC`, wranglerPath };
    }

    const currentDate = parsed.compatibility_date ?? "";

    if (!isCacheEnabled(parsed)) {
        return { changed: false, date: currentDate || undefined, reason: "cache not enabled", wranglerPath };
    }

    // Already sufficient (or newer than required).
    if (currentDate >= WORKERS_CACHE_MIN_DATE) {
        return { changed: false, date: currentDate, reason: `compatibility_date already >= ${WORKERS_CACHE_MIN_DATE}`, wranglerPath };
    }

    // Bump to the minimum required date.
    const edits = modify(text, ["compatibility_date"], WORKERS_CACHE_MIN_DATE, FORMATTING);

    if (edits.length === 0) {
        return { changed: false, date: currentDate || undefined, reason: "no structural edit produced", wranglerPath };
    }

    writeFileSync(wranglerPath, applyEdits(text, edits), "utf8");

    return { changed: true, date: WORKERS_CACHE_MIN_DATE, wranglerPath };
};
