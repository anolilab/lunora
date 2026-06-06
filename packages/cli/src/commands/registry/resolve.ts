/**
 * Resolving registry items/roots — the `--source` safety gate and the giget
 * fetch/staging layer shared by `add`, `list`, and `view`. `giget` is imported
 * lazily so commands that never fetch (e.g. local `--from`) don't pay for it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { join } from "@visulima/path";

import type { Logger } from "../../util/logger.js";
import parseManifest from "./manifest.js";
import type { AddCommandOptions, RegistryManifest, ResolvedItem } from "./types.js";

const DEFAULT_SOURCE_BASE = "gh:anolilab/cirrus/registry";
const DEFAULT_SOURCE_REF = "alpha";

/** Mirror init's `--source` gate: only gh:/github:/https:, and no traversal. */
const isSafeSource = (source: string): boolean => {
    if (source.includes("..")) {
        return false;
    }

    return source.startsWith("gh:") || source.startsWith("github:") || source.startsWith("https://");
};

/** True when a remote `--source` is set but fails the safety gate. */
const isBlockedRemoteSource = (options: AddCommandOptions): boolean =>
    options.from === undefined && options.source !== undefined && options.source.length > 0 && !options.allowUnsafeSource && !isSafeSource(options.source);

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
    const { downloadTemplate } = await import("giget");

    const stagingRoot = mkdtempSync(join(tmpdir(), `cirrus-${label}-fetch-`));
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
 * Resolve a single item's directory: straight from `--from` (offline) or by
 * fetching it via giget. Returns the directory + a cleanup callback.
 */
const resolveItemDirectory = async (name: string, options: AddCommandOptions): Promise<{ cleanup: () => void; directory: string }> => {
    if (options.from !== undefined) {
        const directory = join(options.from, name);

        if (!existsSync(directory)) {
            throw new Error(`registry item not found in local source: ${directory}`);
        }

        return { cleanup: () => {}, directory };
    }

    const base = options.source ?? DEFAULT_SOURCE_BASE;

    return fetchToStaging(`${base}/${name}#${DEFAULT_SOURCE_REF}`, "item", options.logger);
};

/**
 * Resolve the whole registry root (for `list`): a local `--from` dir, or a
 * giget-fetched copy of the remote registry base. Returns the root + cleanup.
 */
const resolveRegistryRoot = async (options: AddCommandOptions): Promise<{ cleanup: () => void; root: string }> => {
    if (options.from !== undefined) {
        if (!existsSync(options.from)) {
            throw new Error(`registry root not found: ${options.from}`);
        }

        return { cleanup: () => {}, root: options.from };
    }

    const base = options.source ?? DEFAULT_SOURCE_BASE;
    const { cleanup, directory } = await fetchToStaging(`${base}#${DEFAULT_SOURCE_REF}`, "registry", options.logger);

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
            throw new Error(`cyclic registry dependency detected at "${name}"`);
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

export { isBlockedRemoteSource, isSafeSource, readManifest, resolveItemDirectory, resolvePlan, resolveRegistryRoot, sourceGateError };
