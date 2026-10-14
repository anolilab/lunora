import { isBuiltin } from "node:module";

import { lunoraRsbuild } from "@lunora/rspack/rsbuild";
import type { RsbuildConfig, RsbuildPlugin } from "@rsbuild/core";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/rsbuild";

type ExternalItem = NonNullable<RsbuildConfig["output"]>["externals"];

/**
 * Keep Node built-ins — `node:stream` and bare `stream` alike — as `node:*` ESM
 * imports. Rspack's default for them is a `createRequire(import.meta.url)` shim,
 * which throws at startup in workerd (`import.meta.url` is undefined there), so
 * the Worker never boots. `nodejs_compat` serves the imports.
 */
const nodeBuiltinsAsImports: ExternalItem = ({ request }, callback) => {
    if (request !== undefined && isBuiltin(request)) {
        callback(undefined, `module ${request.startsWith("node:") ? request : `node:${request}`}`);

        return;
    }

    callback();
};

/**
 * Build the SSR handler for workerd rather than Node: `src/worker.ts` imports
 * it and composes it with Lunora into ONE Worker, which is what `lunora deploy`
 * ships. Worker export conditions pick the fetch-based React DOM server build.
 *
 * A plugin, not a top-level `environments.ssr`: TanStack merges its own SSR
 * environment (`target: "node"`) over the user config, and `@tanstack/react-start`
 * forwards no environment overrides. `modifyEnvironmentConfig` runs after every
 * plugin's config hooks, so this is the value that sticks. `build` only —
 * `rsbuild dev` renders inside the dev server, which loads the bundle as Node.
 */
const ssrForWorkerd = (): RsbuildPlugin => {
    return {
        name: "ssr-for-workerd",
        setup: (api) => {
            api.modifyEnvironmentConfig((config, { mergeEnvironmentConfig, name }) => {
                if (name !== "ssr" || api.context.action !== "build") {
                    return config;
                }

                return mergeEnvironmentConfig(config, {
                    // A web target's defaults would otherwise hash the entry's name and
                    // emit a script with no exports — Rsbuild only emits an ES-module
                    // library for Node targets — and `src/worker.ts` imports this
                    // bundle's `default` export by its plain name.
                    output: { externals: [nodeBuiltinsAsImports], filenameHash: false, module: true, target: "web-worker" },
                    resolve: { conditionNames: ["workerd", "worker", "import", "module", "default"] },
                    tools: { rspack: { output: { library: { type: "module" } } } },
                });
            });
        },
    };
};

/**
 * - `tanstackStart()` builds the client (`dist/client`) and the SSR handler
 *   (`dist/server/index.js`), and generates `src/routeTree.gen.ts`.
 * - `lunoraRsbuild()` runs codegen before every compilation, provisions the
 *   bindings your code implies into `wrangler.jsonc`, serves Lunora Studio at
 *   `/__lunora`, and under `rsbuild dev` starts the Lunora Worker
 *   (`src/lunora.ts`) with `wrangler dev` and proxies `/_lunora/*` to it.
 */
export default defineConfig({
    plugins: [pluginReact(), tanstackStart(), ssrForWorkerd(), lunoraRsbuild()],
});
