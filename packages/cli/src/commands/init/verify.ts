/**
 * Preflight checks before a network scaffold (create-astro's `verify` step): fail
 * fast with a friendly message when the machine is offline or the requested
 * template ref plainly doesn't exist, rather than blowing up mid-fetch with a raw
 * giget error. Skipped entirely for local sources (`--from` / `overlayBaseFrom`)
 * and in `--dry-run`.
 */
import dns from "node:dns/promises";

import type { Logger } from "../../util/logger";

/** A reachable DNS lookup of github.com is a good-enough "are we online?" probe. */
const isOnline = async (): Promise<boolean> =>
    dns.lookup("github.com").then(
        () => true,
        () => false,
    );

/** `gh:owner/repo[/subdir][#ref]` (and the `github:` alias). Captures owner, repo, optional ref. */
const GITHUB_SOURCE = /^(?:gh|github):([^/]+)\/([^#/]+)(?:\/[^#]*)?(?:#(.+))?$/;

/** Parse a `gh:` / `github:` source into its owner / repo / ref; `undefined` for any other scheme. */
const parseGitHubSource = (source: string): { owner: string; ref: string; repo: string } | undefined => {
    const match = GITHUB_SOURCE.exec(source);

    if (match === null) {
        return undefined;
    }

    const [, owner, repo, ref] = match;

    if (owner === undefined || repo === undefined) {
        return undefined;
    }

    return { owner, ref: ref ?? "HEAD", repo };
};

/**
 * Whether a `gh:` source's repo+ref resolves, via a cheap codeload HEAD. Returns
 * `false` only on a definitive 404; `undefined` when it can't be determined
 * cheaply (non-gh source, or a transient network/HTTP hiccup) so the caller does
 * NOT block on uncertainty.
 */
const templateRefExists = async (source: string): Promise<boolean | undefined> => {
    const parsed = parseGitHubSource(source);

    if (parsed === undefined) {
        return undefined;
    }

    const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${parsed.ref}`;

    try {
        const response = await fetch(url, { method: "HEAD" });

        if (response.status === 404) {
            return false;
        }

        return response.ok ? true : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Run the preflight checks for a network scaffold. Returns `true` when it's safe
 * to proceed; on a hard failure it logs a clear, actionable error and returns
 * `false` (the caller aborts with a non-zero code). A no-op (returns `true`) for
 * local sources.
 */
const verifyRemoteTemplate = async (params: { isLocal: boolean; logger: Logger; source?: string }): Promise<boolean> => {
    if (params.isLocal) {
        return true;
    }

    // Only github-backed fetches get the preflight: the default source and the
    // overlay both pull from github, and a `gh:`/`github:` `--source` we can
    // probe. A custom host (`https://…`, a self-hosted git) we can't cheaply
    // reach-check by probing github.com — that would falsely report "offline" —
    // so we let giget surface its own error for those.
    const isGitHubBacked = params.source === undefined || parseGitHubSource(params.source) !== undefined;

    if (!isGitHubBacked) {
        return true;
    }

    if (!(await isOnline())) {
        params.logger.error("you appear to be offline — connect to the internet and try again, or scaffold from a local template with `--from <dir>`.");

        return false;
    }

    if (params.source !== undefined && (await templateRefExists(params.source)) === false) {
        params.logger.error(`template source not found: ${params.source} — double-check --ref / --source, or browse the templates at https://lunora.sh/docs.`);

        return false;
    }

    return true;
};

export { parseGitHubSource, verifyRemoteTemplate };
