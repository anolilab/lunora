/**
 * A small "an update is available" notifier, in the spirit of Vercel's / npm's
 * CLIs. After a command runs, it prints a one-line notice when a newer
 * `@lunora/cli` is published.
 *
 * It is best-effort and deliberately unobtrusive: it never throws (a notifier
 * must never fail a command); it is skipped for the unpublished dev version
 * (`0.0.0`), in CI, when stdout is not a TTY, and when `LUNORA_NO_UPDATE_NOTIFIER`
 * is set; and the registry lookup is cached (default 24h TTL) so there is at most
 * one network call per day, itself bounded by a short timeout.
 *
 * The pure helpers (version compare, cache freshness, notice formatting) carry
 * the logic and are unit-tested; the runtime entry wires them to fs + fetch.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "./logger";

/** The npm dist-tag endpoint resolving the latest published `@lunora/cli`. */
const REGISTRY_URL = "https://registry.npmjs.org/@lunora/cli/latest";
/** Default cache lifetime: one network check per day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound the registry request so a slow network never stalls the CLI. */
const FETCH_TIMEOUT_MS = 1500;
/** The unpublished/dev version — never notify against it. */
const DEV_VERSION = "0.0.0";
/** Optional leading `v` stripped from a version string before parsing. */
const LEADING_V = /^v/u;

interface UpdateCache {
    checkedAt: number;
    latest: string;
}

/** Split a `x.y.z` (with optional `-prerelease`) into numeric [major, minor, patch]; missing parts are 0. */
const versionParts = (version: string): [number, number, number] => {
    const core = version.trim().replace(LEADING_V, "").split("-")[0] ?? "";
    const [major, minor, patch] = core.split(".").map((part) => {
        const n = Number.parseInt(part, 10);

        return Number.isFinite(n) ? n : 0;
    });

    return [major ?? 0, minor ?? 0, patch ?? 0];
};

/** Compare two versions by major.minor.patch (prerelease tags ignored): -1, 0, or 1. */
const compareVersions = (a: string, b: string): number => {
    const pa = versionParts(a);
    const pb = versionParts(b);

    for (let index = 0; index < 3; index += 1) {
        if ((pa[index] ?? 0) !== (pb[index] ?? 0)) {
            return (pa[index] ?? 0) > (pb[index] ?? 0) ? 1 : -1;
        }
    }

    return 0;
};

/** True when `latest` is a strictly newer release than `current`. */
const isNewer = (current: string, latest: string): boolean => compareVersions(latest, current) > 0;

/** A cache entry is fresh while it is within the TTL of `nowMs`. */
const isCacheFresh = (checkedAt: number, nowMs: number, ttlMs: number): boolean => nowMs - checkedAt < ttlMs;

/** The one-line notice shown when an update exists. */
const formatUpdateNotice = (current: string, latest: string): string =>
    `Update available for @lunora/cli: ${current} → ${latest} — run \`pnpm add -D @lunora/cli@latest\``;

const cacheFilePath = (cacheDirectory: string): string => join(cacheDirectory, "lunora-cli-update.json");

/**
 * Resolve the default cache directory to a user-owned location instead of the
 * shared OS temp dir. A world-writable `/tmp` lets a local attacker pre-plant
 * `lunora-cli-update.json` as a symlink so the next `writeCache` clobbers the
 * link target (CWE-377/CWE-59); `$XDG_CACHE_HOME/lunora` (else `~/.cache/lunora`,
 * mode 0700) is owned by the running user, closing that vector. Best-effort:
 * `mkdirSync` is idempotent (`recursive`) and any failure is swallowed by the
 * caller's cache read/write guards, degrading to "re-check next time".
 */
const defaultCacheDirectory = (env: NodeJS.ProcessEnv): string => {
    const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
    const directory = join(base, "lunora");

    try {
        mkdirSync(directory, { mode: 0o700, recursive: true });
    } catch {
        // Best-effort — a failed mkdir degrades to a missing-cache re-check.
    }

    return directory;
};

/** Read the cached latest-version record, or `undefined` (best-effort, never throws). */
const readCache = (cacheDirectory: string): UpdateCache | undefined => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(cacheFilePath(cacheDirectory), "utf8"));

        if (parsed !== null && typeof parsed === "object") {
            const { checkedAt, latest } = parsed as Record<string, unknown>;

            if (typeof latest === "string" && typeof checkedAt === "number") {
                return { checkedAt, latest };
            }
        }
    } catch {
        // Missing / unreadable / malformed cache → treat as no cache.
    }

    return undefined;
};

/** Persist the latest-version record (best-effort, never throws). */
const writeCache = (cacheDirectory: string, cache: UpdateCache): void => {
    try {
        const path = cacheFilePath(cacheDirectory);

        // Defense-in-depth against symlink following (CWE-59): refuse to write
        // through a pre-planted symlink so we truncate the cache, never its
        // link target. `lstatSync` does not follow the final component.
        try {
            if (lstatSync(path).isSymbolicLink()) {
                return;
            }
        } catch {
            // No existing entry (ENOENT) — safe to create it below.
        }

        writeFileSync(path, `${JSON.stringify(cache)}\n`, "utf8");
    } catch {
        // A cache write failure is non-fatal — we just re-check next time.
    }
};

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{ json: () => Promise<unknown>; ok: boolean }>;

/** Fetch the latest published version from npm, or `undefined` on any failure. */
const fetchLatestVersion = async (fetchImpl: FetchLike): Promise<string | undefined> => {
    try {
        const response = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

        if (!response.ok) {
            return undefined;
        }

        const body: unknown = await response.json();
        const version = body !== null && typeof body === "object" ? (body as { version?: unknown }).version : undefined;

        return typeof version === "string" ? version : undefined;
    } catch {
        return undefined;
    }
};

interface NotifyUpdateDeps {
    /** Override the cache directory (defaults to `$XDG_CACHE_HOME/lunora` or `~/.cache/lunora`). */
    cacheDir?: string;
    /** The running CLI version. */
    current: string;
    /** Process env (injected in tests). Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Fetch implementation (injected in tests). Defaults to global `fetch`. */
    fetchImpl?: FetchLike;
    /** Whether stdout is a TTY (injected in tests). Defaults to `process.stdout.isTTY`. */
    isTTY?: boolean;
    logger: Logger;
    /** Clock (injected in tests). Defaults to `Date.now`. */
    now?: () => number;
    /** Cache TTL override (ms). */
    ttlMs?: number;
}

/** True when notifications are disabled by the environment (dev version, CI, opt-out, or non-TTY). */
const isNotifierDisabled = (current: string, env: NodeJS.ProcessEnv, isTty: boolean): boolean =>
    current === DEV_VERSION || !isTty || env.CI !== undefined || env.LUNORA_NO_UPDATE_NOTIFIER !== undefined;

/**
 * Print an "update available" notice when a newer `@lunora/cli` is published.
 * Best-effort and non-blocking-ish: a network lookup happens at most once per
 * TTL and is bounded by a short timeout. Never throws.
 */
const maybeNotifyUpdate = async (deps: NotifyUpdateDeps): Promise<void> => {
    const env = deps.env ?? process.env;
    const isTty = deps.isTTY ?? process.stdout.isTTY;

    if (isNotifierDisabled(deps.current, env, isTty)) {
        return;
    }

    const cacheDirectory = deps.cacheDir ?? defaultCacheDirectory(env);
    const nowMs = (deps.now ?? Date.now)();
    const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;
    const cache = readCache(cacheDirectory);

    let latest = cache?.latest;

    if (cache === undefined || !isCacheFresh(cache.checkedAt, nowMs, ttlMs)) {
        const fetched = await fetchLatestVersion(deps.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch);

        if (fetched !== undefined) {
            latest = fetched;
            writeCache(cacheDirectory, { checkedAt: nowMs, latest: fetched });
        }
    }

    if (latest !== undefined && isNewer(deps.current, latest)) {
        deps.logger.warn(formatUpdateNotice(deps.current, latest));
    }
};

export type { NotifyUpdateDeps, UpdateCache };
export { compareVersions, formatUpdateNotice, isCacheFresh, isNewer, maybeNotifyUpdate };
