import { resolve } from "node:path";

import { readServiceBindings } from "@lunora/codegen";
import type { Plugin } from "vite";

import type { CloudflarePluginOptions } from "./types";

/**
 * Add each `lunora.config` service (plan 457) as an `auxiliaryWorkers` entry, so
 * `vite dev` runs the sibling Workers in the same session and the app's
 * `services[]` bindings resolve locally.
 *
 * Dev only: `vite build` would otherwise build every service as well, an output
 * nothing uses (`lunora deploy` deploys services from their own folders) that
 * breaks the app's build for a service needing its own toolchain. The plugin
 * mutates the options object the Cloudflare plugin was handed, in an
 * `enforce: "pre"` `config` hook — the Cloudflare plugin resolves those options
 * in its own `config` hook, which runs after this one (the same contract
 * `remoteBindingsPlugin` relies on).
 *
 * An entry the user already lists (same `configPath`) is kept as theirs. A
 * declaration codegen cannot wire is left out here; codegen reports it.
 */
const serviceWorkersPlugin = (options: CloudflarePluginOptions, projectRoot: string): Plugin => {
    return {
        config(_userConfig, env) {
            if (env.command !== "serve") {
                return;
            }

            const { services } = readServiceBindings(projectRoot);
            const existing = Array.isArray(options.auxiliaryWorkers) ? (options.auxiliaryWorkers as { configPath?: string }[]) : [];
            const listed = new Set(existing.map((worker) => (worker.configPath === undefined ? "" : resolve(projectRoot, worker.configPath))));
            // Two keys may bind two entrypoints of one Worker: it runs once.
            const added = [...new Set(services.map((service) => service.wranglerPath))]
                .filter((path) => !listed.has(path))
                .map((path) => {
                    return { configPath: path };
                });

            if (added.length > 0) {
                // eslint-disable-next-line no-param-reassign -- the Cloudflare plugin holds this object; see above
                options.auxiliaryWorkers = [...existing, ...added];
            }
        },
        enforce: "pre",
        name: "lunora:service-workers",
    };
};

export default serviceWorkersPlugin;
