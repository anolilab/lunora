import { lunoraLine } from "@lunora/config";

import { resolveOptions } from "./options";
import { LunoraRspackPlugin } from "./plugin";
import type { LunoraRspackOptions } from "./types";
import type { WorkerProcess } from "./worker";
import { resolveWorkerPort, startWorker } from "./worker";

/** Path prefix the Lunora Worker serves — RPC, the WebSocket, and the studio. */
const LUNORA_PATH = "/_lunora";

/** Name Rsbuild lists this plugin under. */
const RSBUILD_PLUGIN_NAME = "lunora:rsbuild";

interface LunoraRsbuildOptions extends LunoraRspackOptions {
    /**
     * Run `wrangler dev` alongside the dev server and proxy {@link LUNORA_PATH}
     * to it. `false` opts out — for a project that starts the Worker itself, or
     * an Rsbuild build with no dev server to attach to.
     *
     * Defaults to `true`.
     */
    worker?: boolean;

    /**
     * Port the Worker serves on. Defaults to the wrangler config's `dev.port`,
     * then `8787`.
     */
    workerPort?: number;

    /** Extra arguments appended to `wrangler dev`. */
    wranglerArgs?: ReadonlyArray<string>;
}

/**
 * The slice of Rsbuild's plugin API this uses, projected structurally for the
 * same reason `./compiler.ts` projects the Rspack compiler: `@rsbuild/core` is an
 * OPTIONAL peer, so its types must not reach this package's published `.d.ts`.
 */
interface RsbuildApiLike {
    modifyRsbuildConfig: (callback: (config: RsbuildConfigLike) => RsbuildConfigLike) => void;
    modifyRspackConfig: (callback: (config: RspackConfigLike) => RspackConfigLike) => void;
    onBeforeStartDevServer: (callback: () => Promise<void> | void) => void;
    onCloseDevServer: (callback: () => Promise<void> | void) => void;
}

/** The slice of the Rspack config this plugin writes. */
interface RspackConfigLike {
    plugins?: unknown[];
}

/** The slice of Rsbuild's config this plugin writes. */
interface RsbuildConfigLike {
    server?: {
        proxy?: Record<string, unknown>;
    };
}

/** The Rsbuild plugin shape. */
interface RsbuildPluginLike {
    name: string;
    setup: (api: RsbuildApiLike) => void;
}

/**
 * Lunora Rsbuild plugin — the one-command dev story.
 *
 * `rsbuild dev` starts the client dev server AND the Lunora Worker, and routes
 * `/_lunora/*` to it. Nothing to wire: no hand-written proxy, no second terminal,
 * no `wrangler.dev.jsonc`.
 *
 * It is a different shape from `lunoraRspack` because Rsbuild plugins are
 * `{ name, setup }` and Rspack plugins are `{ apply }`. This one registers the
 * Rspack plugin itself through `modifyRspackConfig`, so codegen, binding
 * provisioning and wrangler validation come along with it — one entry in
 * `plugins` wires the whole thing.
 *
 * **Why a child process rather than in-process workerd.** `@cloudflare/vite-plugin`
 * runs the Worker inside the dev server using Vite's Environment API: a module
 * runner in workerd pulls each module over RPC from Vite. Rspack has no equivalent
 * runner protocol, and the alternative — bundling the Worker ourselves and handing
 * it to Miniflare — means reimplementing wrangler's `nodejs_compat`, Durable Object
 * migrations, binding wiring and local persistence. `wrangler dev` already does all
 * of that correctly. The process boundary is invisible from the developer's seat;
 * what differs is that the Worker restarts rather than hot-swapping modules.
 *
 * The proxy is same-origin on purpose: the browser talks to the dev server's own
 * origin, so `LunoraClient` needs no CORS and the auth cookie is first-party.
 * `ws: true` is what carries the live-query socket — without it queries answer and
 * subscriptions never arrive, which is the single most expensive way this can be
 * misconfigured by hand.
 */
const lunoraRsbuild = (options?: LunoraRsbuildOptions): RsbuildPluginLike => {
    const resolved = resolveOptions(options);
    const runWorker = options?.worker !== false;
    const port = resolveWorkerPort(resolved.projectRoot, options?.workerPort);

    return {
        name: RSBUILD_PLUGIN_NAME,
        setup: (api: RsbuildApiLike): void => {
            // The codegen half, registered here rather than left to the user: a
            // second thing to add to a second config block is exactly the setup
            // step this plugin exists to remove. Both hooks return a replacement
            // rather than mutating, which Rsbuild supports and which keeps the
            // caller's object untouched.
            api.modifyRspackConfig((config) => {
                return {
                    ...config,
                    plugins: [...(config.plugins ?? []), new LunoraRspackPlugin(resolved)],
                };
            });

            api.modifyRsbuildConfig((config) => {
                return {
                    ...config,
                    server: {
                        ...config.server,
                        proxy: {
                            [LUNORA_PATH]: {
                                changeOrigin: true,
                                // `127.0.0.1`, not `localhost`: Node resolves
                                // `localhost` to `::1` first on some hosts, and
                                // wrangler binds IPv4.
                                target: `http://127.0.0.1:${String(port)}`,
                                ws: true,
                            },
                            // Spread last so an entry the project already declares for
                            // this path wins — the plugin supplies a default, it does
                            // not overrule a deliberate choice.
                            ...config.server?.proxy,
                        },
                    },
                };
            });

            if (!runWorker) {
                return;
            }

            let worker: WorkerProcess | undefined;

            api.onBeforeStartDevServer(async () => {
                // eslint-disable-next-line no-console -- startup notice, before any compilation has a logger
                console.info(lunoraLine(`starting the worker on http://127.0.0.1:${String(port)} …`));

                worker = await startWorker({ port, projectRoot: resolved.projectRoot, wranglerArgs: options?.wranglerArgs });
            });

            api.onCloseDevServer(async () => {
                await worker?.stop();
                worker = undefined;
            });
        },
    };
};

export type { LunoraRsbuildOptions, RsbuildApiLike, RsbuildConfigLike, RsbuildPluginLike, RspackConfigLike };
export { LUNORA_PATH, lunoraRsbuild, RSBUILD_PLUGIN_NAME };
