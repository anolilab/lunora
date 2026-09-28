import { createConfirm, ensureDevVariables, ensureDevWorkerEnv, fillDevSecrets, lunoraLine } from "@lunora/config";
import type { Plugin } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Dev-only Vite plugin that prepares `.dev.vars` before the worker boots.
 * `@cloudflare/vite-plugin` loads `.dev.vars` into the worker's `env`, but the
 * file is gitignored — so a fresh clone has none and the worker throws on the
 * first required secret (e.g. `AUTH_SECRET is required`). All three steps live in
 * `@lunora/config`, shared with `lunora dev` and `@lunora/rspack`.
 *
 * First, {@link ensureDevVariables}: when a `.dev.vars.example` exists, prompt
 * to generate `.dev.vars` from it with secrets auto-filled. Second,
 * {@link fillDevSecrets}: fill any empty/placeholder secret already in
 * `.dev.vars` that Lunora can mint locally (a `lunora add`-scaffolded project
 * writes secrets blank) and ensure `LUNORA_ADMIN_TOKEN` is present + generated —
 * so the worker boots with working secrets and the Studio authenticates without
 * its login gate. No prompt: it only generates locally-derivable values and
 * never overwrites a real one. Third, {@link ensureDevWorkerEnv}.
 *
 * Runs in `configResolved` (awaited by Vite) so it completes before the
 * Cloudflare plugin reads the file. Non-interactive runs decline silently.
 * Skipped under `vite preview`, which resolves with `command: "serve"` and so
 * runs `apply: "serve"` plugins too — previewing a built app must not prompt to
 * scaffold, or write, a dev secrets file.
 */
const devVariablesPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let isPreview = false;

    return {
        apply: "serve",
        // `isPreview` is on the config-hook env only — never on the resolved config.
        config(_userConfig, env) {
            isPreview = env.isPreview === true;
        },
        async configResolved() {
            if (isPreview) {
                return;
            }

            const info = (message: string): void => {
                // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                console.info(lunoraLine(message));
            };

            await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info });

            fillDevSecrets({ cwd: options.projectRoot, info });
            ensureDevWorkerEnv(options.projectRoot, info);
        },
        enforce: "pre",
        name: "lunora:dev-vars",
    };
};

export default devVariablesPlugin;
