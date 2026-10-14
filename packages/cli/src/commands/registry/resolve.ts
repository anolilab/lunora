/**
 * Resolving registry items/roots — the `--source` safety gate and the giget
 * fetch/staging layer shared by `add`, `list`, and `view`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { LunoraError } from "@lunora/errors";
import { join } from "@visulima/path";
import { downloadTemplate } from "giget";

import type { Logger } from "../../util/logger";
import { resolvePinnedSourceRef, resolveSourceRef } from "../../util/source-ref";
import { isCustomRegistrySource } from "./apply";
import parseManifest from "./manifest";
import type { AddCommandOptions, RegistryManifest, ResolvedItem } from "./types";

const DEFAULT_SOURCE_BASE = "gh:anolilab/lunora/registry";

/**
 * A registry item name is a single path segment / identifier. It becomes a
 * filesystem path segment (`join(--from, name)`), a remote giget subpath
 * (`<base>/<name>#<ref>`), and — for schema-extension items — an import
 * specifier and identifier spliced into `lunora/schema.ts`. Allow only
 * letters/digits/`-`/`_`, no leading dot, so a name can never traverse out of
 * the registry root (`../../etc`), inject a path separator, or smuggle code
 * into the generated import.
 */
const VALID_ITEM_NAME = /^[A-Za-z0-9][\w-]*$/u;

/** Throw on any item name that isn't a safe single-segment identifier. */
const assertSafeItemName = (name: string): void => {
    if (!VALID_ITEM_NAME.test(name)) {
        throw new LunoraError(
            "INTERNAL",
            `invalid registry item name "${name}" — names must match ${VALID_ITEM_NAME.source} (letters, digits, "-", "_"; no path separators or "..")`,
        );
    }
};

/** Mirror init's `--source` gate: only gh:/github:/https:, and no traversal. */
const isSafeSource = (source: string): boolean => {
    if (source.includes("..")) {
        return false;
    }

    return source.startsWith("gh:") || source.startsWith("github:") || source.startsWith("https://");
};

/**
 * True when a remote `--source` is set but fails the safety gate. A `--from`
 * root is exempt on purpose: it is read from disk, never fetched, so the
 * fetch-base rules have nothing to gate (its confirmation lives in `apply.ts`).
 */
const isBlockedRemoteSource = (options: AddCommandOptions): boolean =>
    isCustomRegistrySource(options) && options.from === undefined && !options.allowUnsafeSource && !isSafeSource(options.source ?? "");

/**
 * The single source-gate error string for every command (`add`/`list`/`view`),
 * or `undefined` when the source is allowed. One message, one rule.
 */
const sourceGateError = (command: string, options: AddCommandOptions): string | undefined =>
    isBlockedRemoteSource(options)
        ? `${command}: refusing --source ${String(options.source)} — only gh:, github:, or https:// sources are allowed (and may not contain "..").` +
          " Re-run with --allow-unsafe-source if you really want this."
        : undefined;

/**
 * Fetch a remote registry path (`remote`) into a fresh temp dir via giget.
 * Returns the staging dir plus a cleanup callback; removes the temp dir on
 * failure. `label` names the staging subdir (and the temp prefix).
 */
const fetchToStaging = async (remote: string, label: string, logger: Logger): Promise<{ cleanup: () => void; directory: string }> => {
    const stagingRoot = mkdtempSync(join(tmpdir(), `lunora-${label}-fetch-`));
    const stagingDirectory = join(stagingRoot, label);

    logger.info(`fetching ${remote}`);

    try {
        const downloaded = (await downloadTemplate(remote, {
            cwd: stagingRoot,
            dir: stagingDirectory,
            force: true,
            install: false,
            silent: true,
        })) as { commit?: string; source: string };

        logger.info(downloaded.commit ? `resolved ${downloaded.source} @ ${downloaded.commit}` : `resolved ${downloaded.source}`);

        return {
            cleanup: () => {
                rmSync(stagingRoot, { force: true, recursive: true });
            },
            directory: stagingDirectory,
        };
    } catch (error) {
        rmSync(stagingRoot, { force: true, recursive: true });

        throw error;
    }
};

/**
 * Memoized pinned-ref resolution, keyed by the per-command `options` object.
 * A single command may fetch several item directories (`resolvePlan` / `view`)
 * plus the registry root — resolving the moving branch → SHA separately for each
 * would let the branch advance between calls and mix two commits into one
 * operation. Caching the (in-flight) promise per `options` guarantees the branch
 * is pinned exactly ONCE and every fetch in that operation reuses the same SHA.
 * A fresh `options` object per command means no stale pin leaks across commands.
 */
const remoteRefCache = new WeakMap<AddCommandOptions, Promise<string>>();

/**
 * The ref to append to a remote fetch. When the base is the default
 * `gh:anolilab/lunora` registry, pin the moving release branch to the immutable
 * commit it currently points at (supply-chain hardening; logs the SHA, or warns
 * + falls back to the branch when offline / rate-limited). A custom `--source`
 * may point at a different repo we can't resolve against, so it stays unpinned.
 *
 * Resolution is memoized per `options` (see {@link remoteRefCache}) so one
 * command pins once and reuses the same SHA for every fetch it performs.
 */
const resolveRemoteRef = async (options: AddCommandOptions): Promise<string> => {
    const cached = remoteRefCache.get(options);

    if (cached !== undefined) {
        return cached;
    }

    // Only reached once `--from` has been ruled out, so "custom" here means a
    // remote `--source`, whose ref is not pinned.
    const pending = isCustomRegistrySource(options) ? Promise.resolve(resolveSourceRef(options.ref)) : resolvePinnedSourceRef(options.ref, options.logger);

    remoteRefCache.set(options, pending);

    return pending;
};

/**
 * Resolve a single item's directory: straight from `--from` (offline) or by
 * fetching it via giget. Returns the directory + a cleanup callback.
 *
 * `defaultBase` exists because `lunora sdk generate` fetches the same way from a
 * sibling root (`gh:anolilab/lunora/sdks`) — one fetch/staging/`--from` path for
 * both, rather than a second copy that would drift from this one's `--source`
 * gate and ref pinning.
 */
const resolveItemDirectory = async (
    name: string,
    options: AddCommandOptions,
    defaultBase: string = DEFAULT_SOURCE_BASE,
): Promise<{ cleanup: () => void; directory: string }> => {
    assertSafeItemName(name);

    if (options.from !== undefined) {
        const directory = join(options.from, name);

        if (!existsSync(directory)) {
            throw new LunoraError("INTERNAL", `registry item not found in local source: ${directory}`);
        }

        return { cleanup: () => {}, directory };
    }

    const base = options.source ?? defaultBase;

    return fetchToStaging(`${base}/${name}#${await resolveRemoteRef(options)}`, "item", options.logger);
};

/**
 * Resolve the whole registry root (for `list`): a local `--from` dir, or a
 * giget-fetched copy of the remote registry base. Returns the root + cleanup.
 */
const resolveRegistryRoot = async (options: AddCommandOptions): Promise<{ cleanup: () => void; root: string }> => {
    if (options.from !== undefined) {
        if (!existsSync(options.from)) {
            throw new LunoraError("INTERNAL", `registry root not found: ${options.from}`);
        }

        return { cleanup: () => {}, root: options.from };
    }

    const base = options.source ?? DEFAULT_SOURCE_BASE;
    const { cleanup, directory } = await fetchToStaging(`${base}#${await resolveRemoteRef(options)}`, "registry", options.logger);

    return { cleanup, root: directory };
};

/** Read + parse a manifest from an item directory. */
const readManifest = (itemDirectory: string, name: string): RegistryManifest => {
    const raw = JSON.parse(readFileSync(join(itemDirectory, "registry.json"), "utf8")) as unknown;

    return parseManifest(raw, name);
};

/**
 * Resolve the full set of items to install, depth-first so dependencies come
 * before dependents. Returns each item's manifest + resolved directory + a
 * cleanup callback. Detects cycles and de-dupes already-seen items.
 */
const resolvePlan = async (names: ReadonlyArray<string>, options: AddCommandOptions): Promise<{ cleanups: (() => void)[]; items: ResolvedItem[] }> => {
    const items: ResolvedItem[] = [];
    const cleanups: (() => void)[] = [];
    const seen = new Set<string>();
    const inProgress = new Set<string>();

    const visit = async (name: string): Promise<void> => {
        if (seen.has(name)) {
            return;
        }

        if (inProgress.has(name)) {
            throw new LunoraError("INTERNAL", `cyclic registry dependency detected at "${name}"`);
        }

        inProgress.add(name);

        const { cleanup, directory } = await resolveItemDirectory(name, options);

        cleanups.push(cleanup);

        const manifest = readManifest(directory, name);

        // Resolve dependencies first so they land earlier in `items`. Sequential
        // by design — fetch order + cycle detection rely on it, so a parallel
        // map would break correctness.
        for (const requirement of manifest.requires ?? []) {
            // eslint-disable-next-line no-await-in-loop
            await visit(requirement);
        }

        inProgress.delete(name);
        seen.add(name);
        items.push({ directory, manifest });
    };

    try {
        for (const name of names) {
            // eslint-disable-next-line no-await-in-loop
            await visit(name);
        }
    } catch (error) {
        // A mid-plan failure (e.g. a later item 404s) must not leak the staging
        // dirs already fetched for earlier items — the caller only wires up
        // cleanup on success.
        for (const cleanup of cleanups) {
            cleanup();
        }

        throw error;
    }

    return { cleanups, items };
};

export { readManifest, resolveItemDirectory, resolvePlan, resolveRegistryRoot, resolveRemoteRef, sourceGateError };
