import type { Plugin } from "vite";

import { reconcileBindingsSafely } from "./codegen-plugin";
import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Vite plugin that writes the bindings the project's code implies into
 * `wrangler.jsonc` before the worker is built — the same infer → reconcile pass
 * `lunora dev` runs.
 *
 * The timing is the whole point, and it is why this is a `config` hook on an
 * `enforce: "pre"` plugin. `@cloudflare/vite-plugin` parses `wrangler.jsonc` in
 * its OWN `config` hook and builds the miniflare worker options from that
 * already-parsed object; it only starts watching the file in `configureServer`.
 * A write from `configResolved` (or from `buildStart`) therefore lands after the
 * parse and before the watcher exists — the file on disk gains the binding, and
 * the worker boots without `env.DB`.
 *
 * It is registered UNCONDITIONALLY, and separately from
 * `wranglerValidatorPlugin`. Provisioning is not validation: hanging it off the
 * validator meant `validateWrangler: false` — an option whose name promises only
 * that checks are skipped — silently took the write back out of `config` and
 * reinstated exactly that missing-binding boot. `remoteBindingsPlugin` copies the
 * file this hook writes, so it must also stay registered ahead of that one.
 *
 * The reconcile is idempotent, so the codegen plugin's `buildStart` pass still
 * finds nothing to change. Skipped under `vite preview`, which resolves with
 * `command: "serve"`: previewing a built app must not rewrite its config.
 */
const bindingsProvisionPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    return {
        // `isPreview` is on the config-hook env only — never on the resolved config.
        async config(_userConfig, environment) {
            if (environment.isPreview === true) {
                return;
            }

            await reconcileBindingsSafely(options, {
                info: (message: string): void => {
                    // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                    console.info(message);
                },
                warn: (message: string): void => {
                    // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                    console.warn(message);
                },
            });
        },
        enforce: "pre",
        name: "lunora:bindings-provision",
    };
};

export default bindingsProvisionPlugin;
