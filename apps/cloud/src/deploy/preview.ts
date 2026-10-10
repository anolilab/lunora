/**
 * Preview-deployment helpers. Previews are
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

/**
 * Script id for a pull request from a fork, keyed by its number rather than
 * its branch.
 *
 * A fork chooses its own branch name, so naming its preview after the branch
 * would let `fork:feat/x` land on the Worker (and Durable Object data) of the
 * team's own `feat/x` preview. Under one alias a branch preview is always
 * `alias-pr-…` and a fork's `alias-fork-N`, so the two cannot meet. Fork builds are
 * not released at all (`src/builds/release.ts`); this is the second wall.
 */
export const forkPreviewScriptName = (projectSlug: string, pullRequest: number | undefined): string =>
    `${slugify(projectSlug)}-fork-${pullRequest === undefined ? "unknown" : String(pullRequest)}`;

/** Expiry timestamp for a preview created at `now` (default 5-day TTL). */
export const previewExpiry = (now: number, ttlMs: number = PREVIEW_TTL_MS): number => now + ttlMs;
