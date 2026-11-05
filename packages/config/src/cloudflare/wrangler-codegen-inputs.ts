/**
 * The `wrangler.jsonc` facts `runCodegen` takes, read in one parse. Every caller
 * that writes `_generated/` spreads this into its options, so the CLI, the Vite
 * and Rspack plugins and the studio all emit the same files.
 */
import { relative } from "node:path";

import type { WranglerQueueProducerIR, WranglerVariableIR } from "@lunora/codegen";

import { isPlainObject } from "./guards";
import { spaAssetsBinding as spaAssetsBindingOf } from "./spa-assets";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";
import { scanWranglerVariablesForSecrets } from "./wrangler-secret-variables";
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

/** Both inputs are empty when there is no wrangler config or it does not parse. */
const wranglerCodegenInputs = (projectRoot: string): WranglerCodegenInputs => {
    const wranglerPath = findWranglerFile(projectRoot);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerCodegenShape>(wranglerPath).parsed;

    if (wranglerPath === undefined || parsed === undefined) {
        return { wranglerQueueProducers: [], wranglerVariables: [] };
    }

    const spaAssetsBindings = [
        ...new Set([parsed.assets, ...Object.values(parsed.env ?? {}).map((block) => block?.assets)].flatMap((assets) => spaAssetsBindingOf(assets) ?? [])),
    ];

    return {
        ...(spaAssetsBindings.length === 0 ? {} : { spaAssetsBindings }),
        wranglerQueueProducers: [...producersOf(parsed.queues), ...Object.entries(parsed.env ?? {}).flatMap(([env, block]) => producersOf(block?.queues, env))],
        wranglerVariables: scanWranglerVariablesForSecrets(isPlainObject(parsed.vars) ? parsed.vars : undefined, relative(projectRoot, wranglerPath)),
    };
};

export type { WranglerCodegenInputs };
export { wranglerCodegenInputs };
