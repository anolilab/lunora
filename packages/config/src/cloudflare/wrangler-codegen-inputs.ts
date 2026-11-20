/**
 * The `wrangler.jsonc` facts `runCodegen` takes, read in one parse. Every caller
 * that writes `_generated/` spreads this into its options, so the CLI, the Vite
 * and Rspack plugins and the studio all emit the same files.
 */
import { dirname, relative, resolve } from "node:path";

import type { WranglerQueueProducerIR, WranglerVariableIR } from "@lunora/codegen";

import { resolveWorkerEntry } from "../worker-entry";
import { isPlainObject } from "./guards";
import { spaAssetsBinding as spaAssetsBindingOf } from "./spa-assets";
import { studioAssetsPlan } from "./studio-assets";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";
import { scanWranglerVariablesForSecrets, variableKeyLines } from "./wrangler-secret-variables";
import type { QueuesShape } from "./wrangler-shape";

/** The slices read here. Parsed from untrusted JSONC, so any level may be `null` or the wrong type. */
interface WranglerCodegenShape {
    assets?: unknown;
    env?: Record<string, { assets?: unknown; queues?: QueuesShape | null } | null> | null;
    queues?: QueuesShape | null;
    vars?: Record<string, unknown> | null;
}

interface WranglerCodegenInputs {
    /**
     * The assets binding of every `assets` block (top level, then each `env.<name>`) that falls back to a single-page
     * app, each name once. An environment's block replaces the top-level one whole, so each may name its own binding.
     */
    spaAssetsBindings?: string[];

    /**
     * Where Studio's documents ship as Workers Static Assets: the binding, and the assets directory relative to the
     * project root. Absent keeps them in the Worker bundle (see `studio-assets.ts`).
     */
    studioAssets?: { binding: string; directory: string };

    /**
     * The worker entry file the deploy bundles, absolute: the composed `src/worker.ts` when it exists (the deploy
     * passes it in place of `main`), else wrangler's `main`, else the first `WORKER_ENTRY_FALLBACKS` file. Absent when
     * none exists, as for the composed `virtual:lunora/worker`. Codegen's `cloudflare:*` import gate starts from it.
     */
    workerEntry?: string;
    /** Every well-formed `queues.producers[]` entry of the top level and each `env.<name>` block. */
    wranglerQueueProducers: WranglerQueueProducerIR[];

    /** Top-level `vars` entries that look like plaintext secrets. */
    wranglerVariables: WranglerVariableIR[];
}

/** One scope's producers; `env` is absent for the top level. `"producers": {}` parses too, so the array is checked, not trusted. */
const producersOf = (queues: QueuesShape | null | undefined, env?: string): WranglerQueueProducerIR[] => {
    const producers: unknown = queues?.producers;
    const entries: ReadonlyArray<unknown> = Array.isArray(producers) ? producers : [];

    return entries.flatMap((entry) =>
        isPlainObject(entry) && typeof entry.binding === "string" && typeof entry.queue === "string"
            ? [{ binding: entry.binding, queue: entry.queue, ...(env === undefined ? {} : { env }) }]
            : [],
    );
};

/**
 * The wrangler inputs are empty when there is no wrangler config or it does not parse; `workerEntry` is still probed. Pass the `target` codegen runs with, so
 * an explicit `--target` decides the Studio documents' placement the same way `reconcileStudioAssets` does.
 */
const wranglerCodegenInputs = (projectRoot: string, target?: string): WranglerCodegenInputs => {
    const wranglerPath = findWranglerFile(projectRoot);
    const read = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerCodegenShape>(wranglerPath);
    const parsed = read?.parsed;
    // Read whether or not wrangler parses: with no `main` the entry is the first fallback file.
    const workerEntry = resolveWorkerEntry(projectRoot).path;
    const entry = workerEntry === undefined ? {} : { workerEntry };

    if (wranglerPath === undefined || read?.text === undefined || parsed === undefined) {
        return { ...entry, wranglerQueueProducers: [], wranglerVariables: [] };
    }

    const keyLines = variableKeyLines(read.text);
    const spaAssetsBindings = [
        ...new Set([parsed.assets, ...Object.values(parsed.env ?? {}).map((block) => block?.assets)].flatMap((assets) => spaAssetsBindingOf(assets) ?? [])),
    ];

    const studioAssets = studioAssetsPlan(projectRoot, parsed, target);

    return {
        ...(spaAssetsBindings.length === 0 ? {} : { spaAssetsBindings }),
        ...(studioAssets === undefined
            ? {}
            : { studioAssets: { binding: studioAssets.binding, directory: relative(projectRoot, resolve(dirname(wranglerPath), studioAssets.directory)) } }),
        ...entry,
        wranglerQueueProducers: [...producersOf(parsed.queues), ...Object.entries(parsed.env ?? {}).flatMap(([env, block]) => producersOf(block?.queues, env))],
        wranglerVariables: scanWranglerVariablesForSecrets(isPlainObject(parsed.vars) ? parsed.vars : undefined, relative(projectRoot, wranglerPath), (key) =>
            keyLines.get(key),
        ),
    };
};

export type { WranglerCodegenInputs };
export { wranglerCodegenInputs };
