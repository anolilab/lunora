/**
 * Preview-deployment helpers (CLOUD-PLAN.md §2.3 / Phase 2). Previews are
 * per-branch, TTL'd deployments; their script id is derived deterministically
 * from the project + branch so repeated pushes to the same PR update one script.
 */

/** Default preview TTL — 5 days, matching the free-tier window the plan cites. */
export const PREVIEW_TTL_MS = 5 * 24 * 60 * 60 * 1000;

const slugify = (input: string): string => {
    let value = input.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");

    while (value.startsWith("-")) {
        value = value.slice(1);
    }

    while (value.endsWith("-")) {
        value = value.slice(0, -1);
    }

    return value.slice(0, 40);
};

/** Deterministic dispatch-namespace script id for a project's branch preview. */
export const previewScriptName = (projectSlug: string, branch: string): string => `${slugify(projectSlug)}-pr-${slugify(branch)}`;

/** Expiry timestamp for a preview created at `now` (default 5-day TTL). */
export const previewExpiry = (now: number, ttlMs: number = PREVIEW_TTL_MS): number => now + ttlMs;
