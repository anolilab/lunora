import type { Plugin } from "vite";

import type { CloudflarePluginOptions } from "./types";

/**
 * Worker env var the dev tooling sets so the Lunora runtime recognises a
 * development deployment (`@lunora/do`'s `isDevEnvironment`) and therefore
 * streams every RPC dispatch summary to the terminal by default — the
 * `lunora dev` CLI sets the same var via `wrangler dev --var`.
 *
 * It is injected ONLY during `vite` serve, never a production `vite build`, so
 * it can never leak into a deployed worker. A `WORKER_ENV` the user already
 * declares (in `wrangler.jsonc` `[vars]` or `.dev.vars`) takes precedence, so
 * this only fills the gap when none is set.
 */
const DEV_WORKER_ENV_VAR = "WORKER_ENV";
const DEV_WORKER_ENV_VALUE = "development";

/** The structural slice of `@cloudflare/vite-plugin`'s worker config we read/write. */
interface WorkerConfigLike {
    vars?: Record<string, unknown>;
}

/** A `@cloudflare/vite-plugin` `config` customizer: a partial worker config, or a function that mutates the config in place (returning `undefined`/`void`). */
type ConfigCustomizer = ((config: WorkerConfigLike) => Partial<WorkerConfigLike> | undefined) | Partial<WorkerConfigLike>;

/**
 * Wrap the cloudflare-plugin options so the dev worker's `vars` gain a
 * `WORKER_ENV` of `development` when — and only when — `isServe()` reports a
 * `vite` serve. Any `config` customizer the caller already supplied is
 * preserved and applied first; an existing `WORKER_ENV` wins, so a user
 * override is never clobbered.
 */
const withDevWorkerEnv = (options: CloudflarePluginOptions, isServe: () => boolean): CloudflarePluginOptions => {
    const userConfig = options.config as ConfigCustomizer | undefined;

    return {
        ...options,
        config: (workerConfig: WorkerConfigLike): void => {
            /* eslint-disable no-param-reassign -- the cloudflare plugin's `config` customizer contract is to mutate the worker config in place (its return type includes `void`). */
            if (typeof userConfig === "function") {
                const partial = userConfig(workerConfig);

                if (partial) {
                    Object.assign(workerConfig, partial);
                }
            } else if (userConfig) {
                Object.assign(workerConfig, userConfig);
            }

            if (isServe()) {
                workerConfig.vars = { [DEV_WORKER_ENV_VAR]: DEV_WORKER_ENV_VALUE, ...workerConfig.vars };
            }
            /* eslint-enable no-param-reassign */
        },
    };
};

/**
 * A Vite plugin that captures the resolved command (`serve` vs `build`) so
 * {@link withDevWorkerEnv} injects the dev var only during `vite`, plus an
 * `isServe` probe sharing the same closure. `enforce: "pre"` so the command is
 * captured before the cloudflare plugin resolves its worker config.
 */
const createCommandProbe = (): { isServe: () => boolean; plugin: Plugin } => {
    let command: string | undefined;

    return {
        isServe: () => command === "serve",
        plugin: {
            config(_userConfig, env) {
                command = env.command;
            },
            enforce: "pre",
            name: "lunora:command-probe",
        },
    };
};

export { createCommandProbe, DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, withDevWorkerEnv };
export type { WorkerConfigLike };
