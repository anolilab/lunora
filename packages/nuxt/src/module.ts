/**
 * The Lunora **Nuxt module** — single-worker composition, the inverse of the
 * old two-worker split. Instead of Lunora owning the Cloudflare worker entry, it
 * is mounted *inside* Nitro: a server route at `/_lunora/**` (the paths the
 * worker routes on) forwards every RPC / WebSocket / admin request to the project's
 * Lunora app (`createWorker(...)` / `defineApp().build()`), which runs in the
 * same worker Nuxt deploys as. The `ShardDO` Durable Object class is carried to
 * the deployed worker by a root `worker.ts` wrapper (`wrangler.jsonc`'s `main`)
 * that re-exports Nitro's SSR handler plus `ShardDO` — so one `wrangler.jsonc`,
 * one deploy, and a same-origin client. (Nitro's `cloudflare_module` output
 * exports only the SSR handler, so `main` must point at the wrapper, not the raw
 * `.output/server/index.mjs`, or `wrangler deploy` fails on the missing DO.)
 *
 * Add it in `nuxt.config.ts`:
 *
 * ```ts
 * export default defineNuxtConfig({
 *   modules: ["@lunora/nuxt"],
 *   nitro: { preset: "cloudflare_module" },
 * });
 * ```
 *
 * and add a `worker.ts` wrapper at the project root, pointed at by
 * `wrangler.jsonc`'s `main`:
 *
 * ```ts
 * export { default } from "./.output/server/index.mjs";
 * export { ShardDO } from "./lunora/server";
 * ```
 *
 * ## Why this module registers no Vue plugin
 *
 * The `LunoraClient` is provided by a plugin the *project* owns
 * (`plugins/lunora.ts`), not by `addPlugin` from here. That looks like the
 * wrong layer — a module-registered plugin would fix every app rather than
 * only freshly scaffolded ones — and it has been proposed more than once, so
 * the reasons are recorded here rather than re-derived:
 *
 * - **The client URL is not knowable from this module.** In production it is
 *   the page's own origin (`useRequestURL().origin`), but in dev `nuxt dev`
 *   runs Nitro under Node, which cannot host `ShardDO`, so the client must
 *   talk to the `wrangler dev` sidecar instead — on a port the Lunora CLI
 *   resolves per run (`--worker-port`, then wrangler's `dev.port`, then the
 *   first free port at or above 8787). This module sees none of that. It
 *   could only hardcode the template's 8788, which is wrong for exactly the
 *   hand-written apps a module-level fix is meant to serve, or grow a `devUrl`
 *   option the user has to keep in sync with their own wrangler config by
 *   hand.
 * - **It would be a SECOND provider, and the loser is not free.** `addPlugin`
 *   unshifts, so a module plugin installs before the project's own; both call
 *   `app.provide` on the same injection key and the project's wins. That
 *   ordering is the right way round, but it leaves a live orphan: in a browser
 *   the `LunoraClient` constructor auto-probes IndexedDB persistence and
 *   queues outbox hydration, which opens sockets for restored writes. Two
 *   clients would then contend over one durable outbox, one of them dialling a
 *   guessed origin. A loud `useLunora(): no LunoraClient provided` is a better
 *   failure than that.
 * - **Every other framework integration provides the client in user-land**
 *   too (`root.tsx`, `layout.tsx`, `providers.tsx`, `__root.tsx`), for the
 *   same reason: the URL is app-specific. Nuxt silently constructing one would
 *   be the odd case, and it would also force `@lunora/vue` (and Vue) onto apps
 *   that use only the `@lunora/nuxt/server` reactive-loader helpers.
 *
 * What this module does instead is warn — see {@link checkClientOnlyProvider},
 * which catches the actual defect (a `.client.ts` provider, which never runs on
 * the server) at build time, the same stance it already takes for `worker.ts`.
 */

/* eslint-disable import/exports-last -- the public ModuleOptions type is declared next to the module definition it configures rather than grouped at the file end */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { addServerHandler, createResolver, defineNuxtModule, useLogger } from "@nuxt/kit";

import resolveTildePath from "./resolve-tilde-path";

/** Matches a trailing `.js` extension so it can be swapped for `.ts` (module-scope: compiled once). */
const JS_EXTENSION_SUFFIX = /\.js$/;

/**
 * Minimal structural shape of the rollup plugin this module contributes (a
 * `name` + an object-form `resolveId` hook). Declared locally because `rollup`
 * is not a direct dependency — it's the Nitro server bundler, resolved at the
 * consumer's build time — and this object is a valid rollup plugin at runtime.
 */
interface TsSourceResolverPlugin {
    name: string;
    resolveId: {
        handler: (source: string, importer: string | undefined) => string | undefined;
        order: "pre";
    };
}

/** Minimal shape of the `nitro:config` hook payload this module mutates (Nitro's `NitroConfig` isn't in the installed Nuxt Kit typed hook map). */
interface NitroConfigLike {
    rollupConfig?: { plugins?: unknown[] };
}

/**
 * Rollup plugin (injected into the Nitro server build) that rewrites codegen's
 * NodeNext `.js`-extension imports to their real `.ts` source. `@lunora/codegen`
 * deliberately emits `.js` specifiers (mandatory under NodeNext), and Vite/esbuild
 * resolve those to the `.ts` files — but Nitro's server rollup does NOT, so the
 * Lunora app entry chain (`lunora/server.ts` to `_generated/app.ts`) fails to
 * bundle with "Cannot resolve ... and externals are not allowed". This resolves
 * `#lunora/*` (mapped to `rootDir/lunora/*` by the project package.json
 * `imports`) and relative `.js` imports to a sibling `.ts` when one exists — a
 * strict no-op for every other `.js` (only rewrites when the `.ts` is present).
 */
const lunoraTsSourceResolver = (rootDirectory: string): TsSourceResolverPlugin => {
    const lunoraDirectory = join(rootDirectory, "lunora");

    return {
        name: "lunora:nitro-ts-source-resolve",
        resolveId: {
            handler(source: string, importer: string | undefined): string | undefined {
                if (!source.endsWith(".js")) {
                    return undefined;
                }

                let absolute: string | undefined;

                if (source.startsWith("#lunora/")) {
                    absolute = join(lunoraDirectory, source.slice("#lunora/".length));
                } else if (source.startsWith(".") && importer !== undefined) {
                    absolute = resolve(dirname(importer), source);
                }

                if (absolute === undefined) {
                    return undefined;
                }

                const tsSource = absolute.replace(JS_EXTENSION_SUFFIX, ".ts");

                return existsSync(tsSource) ? tsSource : undefined;
            },
            order: "pre",
        },
    };
};

/** Wrapper snippet shown in every `worker.ts` warning — kept as one constant so the three messages below stay byte-identical. */
const WORKER_TS_SNIPPET = 'export { default } from "./.output/server/index.mjs"; export { ShardDO } from "./lunora/server";';

/** Whether the source has an `export` keyword anywhere at all. */
const EXPORT_KEYWORD_PATTERN = /\bexport\b/u;

/** Whether the source mentions the `ShardDO` identifier anywhere at all. */
const SHARD_DO_IDENTIFIER_PATTERN = /\bShardDO\b/u;

/** `export * from` a specifier containing "lunora" — re-exports everything (including `ShardDO`) from a barrel without naming it, the common case being `export * from "./lunora/server"`. */
const LUNORA_STAR_EXPORT_PATTERN = /\bexport\s*\*\s*from\s*["'][^"']*lunora[^"']*["']/u;

/**
 * Whether `source` looks like it exports `ShardDO` — the file has an `export`
 * keyword AND either mentions the `ShardDO` identifier somewhere (covers
 * `export { ShardDO } from "./lunora/server"`, a local `export { ShardDO }`,
 * `export { X as ShardDO }` — a binding named `ShardDO` is what wrangler
 * resolves the Durable Object class by, whether it's the bare name or the
 * right side of `as`) or re-exports a lunora barrel wholesale via
 * {@link LUNORA_STAR_EXPORT_PATTERN}.
 *
 * Deliberately two independent, simple keyword/identifier checks rather than
 * one combined regex trying to prove `ShardDO` sits INSIDE a specific `export`
 * statement — not a real TS parse (mirrors `@lunora/astro`'s
 * `WITH_LUNORA_CALL_PATTERN`: a documented regex is judged proportionate to a
 * build-time warning hook; ts-morph would be heavier than this hook
 * warrants). Known imprecisions: false-POSITIVE on `export { ShardDO as
 * Other }` (renames `ShardDO` away, so the binding wrangler needs is actually
 * named `Other` — not caught), on a `ShardDO` mention inside a comment
 * anywhere alongside an unrelated `export`, or in principle on `export`ing
 * something else entirely while `ShardDO` is merely imported (not exported)
 * elsewhere in the file. All are accepted trade-offs for a two-line worker
 * entry file, where the realistic failure mode is "forgot the line
 * entirely", not an adversarial one.
 */
const looksLikeShardDoExport = (source: string): boolean => {
    if (!EXPORT_KEYWORD_PATTERN.test(source)) {
        return false;
    }

    return SHARD_DO_IDENTIFIER_PATTERN.test(source) || LUNORA_STAR_EXPORT_PATTERN.test(source);
};

/**
 * Check that `worker.ts` at the project root actually re-exports `ShardDO` —
 * not just that the file exists. Extracted from `setup()` so it is testable
 * without booting Nuxt (`defineNuxtModule`'s `setup` needs full Nuxt Kit
 * scaffolding to invoke; this plain function does not).
 *
 * All three outcomes — missing file, unreadable file, present-but-no-`ShardDO`-
 * export — WARN and return; none of them throws. Matches the module's existing
 * stance ("we can't write the user's file, so warn... rather than fail an
 * otherwise-valid build") and the `@lunora/astro` precedent this mirrors.
 */
export const checkWorkerEntry = (rootDirectory: string, warn: (message: string) => void): void => {
    const workerPath = join(rootDirectory, "worker.ts");

    if (!existsSync(workerPath)) {
        warn(
            `missing worker.ts at the project root — add a wrapper that re-exports Nitro's handler and \`ShardDO\` (\`${WORKER_TS_SNIPPET}\`) and point wrangler's \`main\` at it, so the SHARD Durable Object is exported from the deployed worker.`,
        );

        return;
    }

    let source: string;

    try {
        source = readFileSync(workerPath, "utf8");
    } catch (error) {
        // `existsSync` passing doesn't guarantee a readable regular file (it
        // could be a directory, permission-denied, a broken symlink loop, …) —
        // this hook warns rather than fails the build, so a read failure must
        // degrade to a warning too, not an uncaught throw out of `setup()`.
        const reason = error instanceof Error ? error.message : String(error);

        warn(`could not read worker.ts at the project root (${reason}) — skipping the \`ShardDO\` export check.`);

        return;
    }

    if (!looksLikeShardDoExport(source)) {
        warn(
            `worker.ts at the project root does not appear to export \`ShardDO\` — add \`export { ShardDO } from "./lunora/server";\` (e.g. \`${WORKER_TS_SNIPPET}\`) and point wrangler's \`main\` at it, so the SHARD Durable Object is exported from the deployed worker.`,
        );
    }
};

/** Any file Nuxt will load as a plugin (`.ts`, `.js`, and the `.mts`/`.cts`/`.mjs`/`.cjs` forms). */
const PLUGIN_FILE_SUFFIX = /\.[cm]?[jt]s$/u;

/** A plugin filename Nuxt loads in the browser ONLY — `foo.client.ts` and its extension variants. */
const CLIENT_ONLY_PLUGIN_SUFFIX = /\.client\.[cm]?[jt]s$/u;

/** Whether the source installs `@lunora/vue`'s provider (`app.use(createLunora(client))`). */
const CREATE_LUNORA_PATTERN = /\bcreateLunora\b/u;

/** Read `path` and report whether it mentions `createLunora`; an unreadable file simply doesn't count as a provider. */
const providesLunoraClient = (path: string): boolean => {
    try {
        return CREATE_LUNORA_PATTERN.test(readFileSync(path, "utf8"));
    } catch {
        return false;
    }
};

/**
 * Warn when the project's ONLY `LunoraClient` provider is a client-only plugin.
 *
 * `@lunora/vue`'s composables call `useLunora()` unconditionally — ahead of
 * their own browser guard — and it throws when nothing is injected. A
 * `plugins/lunora.client.ts` by definition never runs on the server, so the
 * first server-rendered page touching Lunora answers 500 with
 * `useLunora(): no LunoraClient provided`. The fix is dropping `.client` from
 * the filename plus a universal way to read the origin, which the warning says.
 *
 * Only fires when *no* universal plugin provides a client, so an app that keeps
 * a correct `plugins/lunora.ts` alongside some other `.client.ts` file is
 * silent. Detection is the same shape as {@link looksLikeShardDoExport}: a
 * documented keyword test, not a TS parse, because the outcome is a build-time
 * warning. Its imprecision is a `createLunora` mention inside a comment, whose
 * only cost is a warning pointing at a file that is already about the client.
 *
 * Scans `srcDirectory` (Nuxt's `srcDir`, which is where `plugins/` lives —
 * `app/` by default in Nuxt 4), recursively, so nested plugin directories count
 * too. A project with no `plugins/` directory is silent.
 */
export const checkClientOnlyProvider = (srcDirectory: string, warn: (message: string) => void): void => {
    const pluginsDirectory = join(srcDirectory, "plugins");

    let entries: unknown[];

    try {
        entries = readdirSync(pluginsDirectory, { recursive: true });
    } catch {
        // No `plugins/` directory (or it is unreadable) — nothing to check.
        return;
    }

    const providers = entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.split("\\").join("/"))
        .filter((entry) => PLUGIN_FILE_SUFFIX.test(entry) && providesLunoraClient(join(pluginsDirectory, entry)));

    if (providers.length === 0 || providers.some((entry) => !CLIENT_ONLY_PLUGIN_SUFFIX.test(entry))) {
        return;
    }

    warn(
        `the only plugin providing a \`LunoraClient\` is client-only (${providers.map((entry) => `plugins/${entry}`).join(", ")}) — ` +
            `\`@lunora/vue\`'s composables resolve the client during SSR too and throw \`useLunora(): no LunoraClient provided\` without one, ` +
            `so the first server-rendered page that touches Lunora answers 500. Drop the \`.client\` from the filename to make the plugin ` +
            `universal, and read the origin with \`useRequestURL().origin\`, which resolves from the incoming request on the server and from ` +
            `\`window.location\` in the browser.`,
    );
};

/** The fixed path prefix the Lunora worker routes on (`RPC_PATH` / `WS_PATH` in `@lunora/runtime`). */
const LUNORA_ROUTE_PREFIX = "/_lunora";

/** Options for the `@lunora/nuxt` module (configurable under the `lunora` key in `nuxt.config`). */
export interface ModuleOptions {
    /**
     * Module specifier of the Lunora app entry — its default export is the built
     * worker (`defineApp().build()` / `createWorker(...)`) and it re-exports
     * `ShardDO`. Aliased to the `#lunora/app` virtual the server route imports.
     */
    appEntry: string;
}

/**
 * Return type of `defineNuxtModule<ModuleOptions>({...})` — the value overload of
 * `defineNuxtModule` (the one taking a definition), extracted structurally so the
 * default export has a locally-nameable type under `isolatedDeclarations` without
 * importing `NuxtModule` from `@nuxt/schema` (not a resolvable dependency here).
 */
type LunoraNuxtModule = typeof defineNuxtModule<ModuleOptions> extends {
    (definition: infer _Definition): infer Result;
    (): unknown;
}
    ? Result
    : never;

const lunoraNuxtModule: LunoraNuxtModule = defineNuxtModule<ModuleOptions>({
    defaults: {
        appEntry: "~/lunora/server",
    },
    meta: {
        configKey: "lunora",
        name: "@lunora/nuxt",
    },
    setup(options, nuxt) {
        const resolver = createResolver(import.meta.url);

        // Alias the `#lunora/app` virtual (imported by the Nitro server route) to
        // the project's Lunora app entry, resolved to an ABSOLUTE path first (see
        // resolveTildePath — a `~` tilde would be re-resolved against Nitro's own
        // `server/` dir and break the server build). Nuxt forwards `options.alias`
        // into the Nitro server bundle, so the server route resolves it there too.
        // eslint-disable-next-line no-param-reassign -- nuxt.options is the documented module-mutation surface
        nuxt.options.alias["#lunora/app"] = resolveTildePath(options.appEntry, nuxt.options.rootDir, nuxt.options.srcDir);

        // Teach the Nitro server bundle to resolve codegen's `.js` imports to
        // their `.ts` source (rollup, unlike Vite/esbuild, won't). Without this
        // the aliased app entry chain (`lunora/server.ts` → `_generated/*`) fails
        // to bundle. Injected via `nitro:config` so it rides on the server build.
        // That hook + `NitroConfig` aren't in this @nuxt/kit version's typed maps,
        // so cast the hook name + config to the minimal shape this touches.
        (nuxt as unknown as { hook: (name: "nitro:config", callback: (config: NitroConfigLike) => void) => void }).hook("nitro:config", (nitroConfig) => {
            const plugins = [...(nitroConfig.rollupConfig?.plugins ?? []), lunoraTsSourceResolver(nuxt.options.rootDir)];

            // eslint-disable-next-line no-param-reassign -- the nitro:config hook exists to mutate the passed config
            nitroConfig.rollupConfig = { ...nitroConfig.rollupConfig, plugins };
        });

        // Mount Lunora realtime (RPC + WebSocket + admin) as a Nitro server route.
        // The handler reconstructs a Web Request, resolves the Cloudflare env/ctx
        // off the event, and forwards to the Lunora app's `fetch` in-process.
        //
        // The mount is fixed, not an option: `createWorker` routes on the
        // `/_lunora/rpc` + `/_lunora/ws` constants and the generated client calls
        // them, so a configurable prefix could only mount a route whose every
        // request the worker answers 404 — which is what it used to do.
        addServerHandler({
            handler: resolver.resolve("./runtime/server/lunora"),
            route: `${LUNORA_ROUTE_PREFIX}/**`,
        });

        // The `ShardDO` class must reach the deployed Cloudflare worker: Nitro's
        // `cloudflare_module` output exports only the SSR handler, so the project
        // needs a root `worker.ts` wrapper (pointed at by `wrangler.jsonc`'s
        // `main`) that re-exports `ShardDO` too. We can't write the user's file,
        // so warn — for a missing file, an unreadable one, or one that exists
        // but doesn't actually export `ShardDO` — rather than fail an
        // otherwise-valid build. See `checkWorkerEntry` for the three checks.
        checkWorkerEntry(nuxt.options.rootDir, (message) => {
            useLogger("@lunora/nuxt").warn(message);
        });

        // The client-side counterpart: the project (not this module) owns the
        // plugin that provides the `LunoraClient` — see the file docblock for
        // why — so the one failure mode we can still catch cheaply is a
        // provider that never runs on the server. Same warn-don't-fail stance.
        checkClientOnlyProvider(nuxt.options.srcDir, (message) => {
            useLogger("@lunora/nuxt").warn(message);
        });
    },
});

export default lunoraNuxtModule;
