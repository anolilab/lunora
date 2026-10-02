import type { IncomingMessage, ServerResponse } from "node:http";

import type { CelldDevSession } from "@lunora/config";
import { lunoraLine, startCelldDevSession, targetRunsOwnDevServer } from "@lunora/config";
import { createStudioMiddleware, isNonLoopbackHost, studioMountPath } from "@lunora/config/studio-host";

import { resolveOptions } from "./options";
import { LunoraRspackPlugin } from "./plugin";
import type { LunoraRspackOptions, ResolvedLunoraRspackOptions } from "./types";
import type { WorkerProcess } from "./worker";
import { printWorkerLine, resolveWorkerPort, startWorker } from "./worker";

/** Path prefix the Lunora Worker serves — RPC, the WebSocket, and the studio. */
const LUNORA_PATH = "/_lunora";

/** Name Rsbuild lists this plugin under. */
const RSBUILD_PLUGIN_NAME = "lunora:rsbuild";

interface LunoraRsbuildOptions extends LunoraRspackOptions {
    /**
     * Serve Lunora Studio at `/__lunora` on the dev server — the same URL, and
     * the same app, as `@lunora/vite`. Needs `@lunora/studio` installed.
     * `false` opts out.
     *
     * Defaults to `true`.
     */
    studio?: boolean;

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
    getRsbuildConfig: () => Readonly<RsbuildConfigLike>;
    modifyRsbuildConfig: (callback: (config: RsbuildConfigLike) => RsbuildConfigLike) => void;
    modifyRspackConfig: (callback: (config: RspackConfigLike) => RspackConfigLike) => void;
    onAfterStartDevServer: (callback: (params: { port: number }) => Promise<void> | void) => void;
    onBeforeStartDevServer: (callback: (params: { server: DevServerLike }) => Promise<void> | void) => void;
    onCloseDevServer: (callback: () => Promise<void> | void) => void;
}

/** The slice of Rsbuild's dev server this uses: its Connect middleware stack. */
interface DevServerLike {
    middlewares: {
        use: (handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void) => unknown;
    };
}

/** A single entry of Rsbuild's array-form `server.proxy`. */
type ProxyArrayEntry = Record<string, unknown> & { pathFilter?: unknown };

/**
 * Rsbuild's `server.proxy`, which is a record OR an array — the distinction that
 * matters, because spreading an array into an object literal turns its entries
 * into numeric keys and Rsbuild then reads each key as a `pathFilter`, silently
 * unrouting every rule that relied on the default match-all.
 */
type ProxyConfigLike = ProxyArrayEntry[] | Record<string, unknown>;

/** The slice of the Rspack config this plugin writes. */
interface RspackConfigLike {
    plugins?: unknown;
}

/** The slice of Rsbuild's config this plugin writes. */
interface RsbuildConfigLike {
    server?: {
        base?: string;
        host?: string;
        proxy?: ProxyConfigLike;
    };
}

/** The Rsbuild plugin shape. */
interface RsbuildPluginLike {
    name: string;
    setup: (api: RsbuildApiLike) => void;
}

/**
 * Add the Lunora route to whichever form of `server.proxy` the project uses,
 * without converting one form into the other.
 *
 * In both forms the project's own entry for this path WINS: the plugin supplies
 * a default, not a policy. `127.0.0.1` rather than `localhost` because Node
 * resolves `localhost` to `::1` first on some hosts while wrangler binds IPv4.
 */
// eslint-disable-next-line sonarjs/function-return-type -- returning the SAME form it was given is the whole contract; collapsing an array into a record is the bug this exists to prevent
const withLunoraProxy = (existing: ProxyConfigLike | undefined, port: number): ProxyConfigLike => {
    const target = `http://127.0.0.1:${String(port)}`;

    if (Array.isArray(existing)) {
        // Appended, so an earlier rule the project declared for this path still
        // matches first.
        return [...existing, { changeOrigin: true, pathFilter: LUNORA_PATH, target, ws: true }];
    }

    return { [LUNORA_PATH]: { changeOrigin: true, target, ws: true }, ...existing };
};

/**
 * Serve Lunora Studio at `/__lunora` — the same middleware, and so the same URL
 * and app, as `@lunora/vite`.
 *
 * Mounted in `onBeforeStartDevServer`, which runs it AHEAD of Rsbuild's
 * built-ins: registered after them, the `/_lunora` proxy and the SPA history
 * fallback would answer a deep link like `/__lunora/data` with the app's own
 * `index.html`. `server.base` and `server.host` are read at that point, after
 * every plugin's `modifyRsbuildConfig`, and before Rsbuild fills in defaults —
 * so an unset host (Rsbuild's `0.0.0.0` default) is told apart from an explicit
 * `--host`.
 */
const mountStudio = (api: RsbuildApiLike, options: ResolvedLunoraRspackOptions): void => {
    api.onBeforeStartDevServer(({ server }) => {
        const { base, host } = api.getRsbuildConfig().server ?? {};

        server.middlewares.use(
            createStudioMiddleware({
                apiSpec: options.apiSpec,
                base,
                isNonLoopbackBind: isNonLoopbackHost(host),
                projectRoot: options.projectRoot,
                schemaDirectory: options.schemaDir,
            }),
        );
    });

    api.onAfterStartDevServer(({ port }) => {
        // eslint-disable-next-line no-console -- startup notice, beside Rsbuild's own URL banner
        console.info(lunoraLine(`studio on http://localhost:${String(port)}${studioMountPath(api.getRsbuildConfig().server?.base)}`));
    });
};

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
    const port = resolveWorkerPort(resolved.projectRoot, options?.workerPort, options?.wranglerArgs);
    // ONE instance, built here rather than inside `modifyRspackConfig` — Rsbuild
    // invokes that callback once per environment, and a per-environment instance
    // defeats the plugin's own in-flight guard: an SSR project would run
    // concurrent codegen passes, two `postcodegen` subprocesses, racing writes to
    // `_generated/` and `wrangler.jsonc`, and two interactive `.dev.vars` prompts.
    const codegenPlugin = new LunoraRspackPlugin(resolved);

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
                    plugins: [...(Array.isArray(config.plugins) ? (config.plugins as unknown[]) : []), codegenPlugin],
                };
            });

            api.modifyRsbuildConfig((config) => {
                return {
                    ...config,
                    server: { ...config.server, proxy: withLunoraProxy(config.server?.proxy, port) },
                };
            });

            if (options?.studio !== false) {
                mountStudio(api, resolved);
            }

            if (options?.worker === false) {
                return;
            }

            let worker: WorkerProcess | undefined;
            let celld: CelldDevSession | undefined;

            api.onBeforeStartDevServer(async () => {
                // BEFORE the spawn. Rsbuild runs this hook ahead of the first
                // compilation, so the codegen plugin's own `.dev.vars` scaffolding
                // would otherwise land after wrangler has already read its bindings
                // — and wrangler reads `.dev.vars` exactly once, at startup. On a
                // fresh clone (where the file is absent, being gitignored) that
                // means a Worker with every secret `undefined` for the whole
                // session, surfacing as auth failures rather than a clear error.
                await codegenPlugin.prepareDevSession();
                // Also before the spawn: wrangler bundles the Worker at startup, and
                // on a fresh clone the `_generated/app` it imports does not exist
                // until a codegen pass writes it.
                await codegenPlugin.generateForDev();

                // eslint-disable-next-line no-console -- startup notice, before any compilation has a logger
                console.info(lunoraLine(`starting the worker on http://127.0.0.1:${String(port)} …`));

                // celld runs its own dev server: `celld dev` serves the Worker,
                // with each `lunora.config` service registered into its local
                // state first, behind the same proxy.
                if (targetRunsOwnDevServer(resolved.target)) {
                    celld = await startCelldDevSession({
                        log: (line, source) => {
                            printWorkerLine(source === "app" ? line : `[${source}] ${line}`);
                        },
                        port,
                        projectRoot: resolved.projectRoot,
                    });

                    return;
                }

                worker = await startWorker({ port, projectRoot: resolved.projectRoot, wranglerArgs: options?.wranglerArgs });
            });

            api.onCloseDevServer(async () => {
                await worker?.stop();
                await celld?.stop();
                worker = undefined;
                celld = undefined;
            });
        },
    };
};

export type { DevServerLike, LunoraRsbuildOptions, ProxyConfigLike, RsbuildApiLike, RsbuildConfigLike, RsbuildPluginLike, RspackConfigLike };
export { LUNORA_PATH, lunoraRsbuild, RSBUILD_PLUGIN_NAME, withLunoraProxy };
