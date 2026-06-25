import { createConfirm, ensureDevVariables, fillDevSecrets } from "@lunora/config";
import type { Plugin } from "vite";

import { lunoraLine } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Dev-only Vite plugin that prepares `.dev.vars` before the worker boots.
 * `@cloudflare/vite-plugin` loads `.dev.vars` into the worker's `env`, but the
 * file is gitignored — so a fresh clone has none and the worker throws on the
 * first required secret (e.g. `AUTH_SECRET is required`). Two steps, both shared
 * with `lunora dev` via `@lunora/config`.
 *
 * First, {@link ensureDevVariables}: when a `.dev.vars.example` exists, prompt
 * to generate `.dev.vars` from it with secrets auto-filled. Second,
 * {@link fillDevSecrets}: fill any empty/placeholder secret already in
 * `.dev.vars` (a `lunora add`-scaffolded project writes secrets blank) and
 * ensure `LUNORA_ADMIN_TOKEN` is present + generated — so the worker boots with
 * working secrets and the Studio authenticates without its login gate. No
 * prompt: it only generates locally-derivable values and never overwrites a real
 * one.
 *
 * Runs in `configResolved` (awaited by Vite) so it completes before the
 * Cloudflare plugin reads the file. Non-interactive runs decline silently.
 */
const devVariablesPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    return {
        apply: "serve",
        async configResolved() {
            const info = (message: string): void => {
                // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                console.info(lunoraLine(message));
            };

            await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info });

            fillDevSecrets({ cwd: options.projectRoot, info });
        },
        enforce: "pre",
        name: "lunora:dev-vars",
    };
};

export default devVariablesPlugin;
