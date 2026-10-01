import { resolve } from "node:path";

import { readServiceBindings } from "@lunora/codegen";

import type { CloudflarePluginOptions } from "./types";

/**
 * Add each `lunora.config` service (plan 457) as an `auxiliaryWorkers` entry, so
 * `vite dev` runs the sibling Workers in the same session and the app's
 * `services[]` bindings resolve locally. An entry the user already lists (same
 * `configPath`) is kept as theirs. A declaration codegen cannot wire is left
 * out here; codegen reports it.
 */
const withServiceWorkers = (options: CloudflarePluginOptions, projectRoot: string): CloudflarePluginOptions => {
    const { services } = readServiceBindings(projectRoot);

    if (services.length === 0) {
        return options;
    }

    const existing = Array.isArray(options.auxiliaryWorkers) ? (options.auxiliaryWorkers as { configPath?: string }[]) : [];
    const listed = new Set(existing.map((worker) => (worker.configPath === undefined ? "" : resolve(projectRoot, worker.configPath))));
    // Two keys may bind two entrypoints of one Worker: it runs once.
    const added = [...new Set(services.map((service) => service.wranglerPath))]
        .filter((path) => !listed.has(path))
        .map((path) => {
            return { configPath: path };
        });

    return added.length === 0 ? options : { ...options, auxiliaryWorkers: [...existing, ...added] };
};

export default withServiceWorkers;
