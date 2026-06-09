import { createConfirm, ensureDevVariables } from "@cirrus/config";
import type { Plugin } from "vite";

import type { ResolvedCirrusPluginOptions } from "./types";

/**
 * Dev-only Vite plugin that offers to scaffold `.dev.vars` before the worker
 * boots. `@cloudflare/vite-plugin` loads `.dev.vars` into the worker's `env`,
 * but the file is gitignored — so a fresh clone has none and the worker throws
 * on the first required secret (e.g. `AUTH_SECRET is required`). When a
 * `.dev.vars.example` exists, we prompt to generate `.dev.vars` from it with
 * secrets auto-filled. Identical behaviour to `cirrus dev` — both call
 * `ensureDevVariables` from `@cirrus/config`.
 *
 * Runs in `configResolved` (awaited by Vite) so it completes before the
 * Cloudflare plugin reads the file. Non-interactive runs decline silently.
 */
const devVariablesPlugin = (options: ResolvedCirrusPluginOptions): Plugin => {
    return {
        apply: "serve",
        async configResolved() {
            await ensureDevVariables({
                confirm: createConfirm("[cirrus] "),
                cwd: options.projectRoot,
                info: (message) => {
                    // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                    console.info(`[cirrus] ${message}`);
                },
            });
        },
        enforce: "pre",
        name: "cirrus:dev-vars",
    };
};

export default devVariablesPlugin;
