import { createRequire } from "node:module";

import { cloudflare } from "@cloudflare/vite-plugin";
import errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

import agentRulesHintPlugin from "./agent-rules-hint-plugin";
import codegenPlugin from "./codegen-plugin";
import containerLogsPlugin from "./container-logs-plugin";
import devStatePlugin from "./dev-state-plugin";
import devVariablesPlugin from "./dev-variables-plugin";
import { createCommandProbe, withDevWorkerEnv } from "./dev-worker-env";
import { frameworkComposePlugin } from "./framework-compose-plugin";
import { createPluginContext, frameworkDetectPlugin } from "./framework-detect-plugin";
import logStreamPlugin from "./log-stream-plugin";
import { proxyCheckPlugin } from "./proxy-check-plugin";
import { planViteRemoteBindings, remoteBindingsCleanupPlugin, remoteBindingsConfigPlugin } from "./remote-bindings-plugin";
import { lunoraSolutionFinders } from "./solution-finders";
import { studioPlugin } from "./studio-plugin";
import type { CloudflarePluginOptions, LunoraPluginOptions, LunoraPlugins, OverlayPluginOptions, ResolvedLunoraPluginOptions } from "./types";
import { withWorkerStartupHint } from "./worker-startup-hint";
import { wranglerValidatorPlugin } from "./wrangler-validator-plugin";

/**
 * Resolve the `overlay` toggle into the overlay plugin's options — or `false` to
 * skip it. Lunora's solution finders are **prepended** so they run before the
 * overlay's built-ins; a user's own finders are appended and can still win per
 * error via a strictly higher `priority` (equal priority keeps Lunora first,
 * since the overlay sorts stably). Lunora also forwards both `error` AND `warn`
 * console calls by default (the overlay's own default is `["error"]` only) so
 * Lunora's branded `warn` advisories surface in the browser too — the user can
 * override `forwardedConsoleMethods`.
 */
// eslint-disable-next-line sonarjs/function-return-type -- returns the overlay options object, or false to skip; the union mirrors the resolved overlay field.
const resolveOverlayOption = (overlay: LunoraPluginOptions["overlay"]): false | OverlayPluginOptions => {
    if (overlay === false) {
        return false;
    }

    const userOverlay = overlay === true || overlay === undefined ? {} : overlay;

    return {
        ...userOverlay,
        // After the spread + nullish-coalesce so an explicit `undefined` from the
        // user doesn't erase Lunora's default (the spread would otherwise win).
        forwardedConsoleMethods: userOverlay.forwardedConsoleMethods ?? ["error", "warn"],
        solutionFinders: [...lunoraSolutionFinders, ...(userOverlay.solutionFinders ?? [])],
    };
};

const resolveOptions = (options: LunoraPluginOptions | undefined): ResolvedLunoraPluginOptions => {
    const input = options ?? {};
    const schemaDirectory = input.schemaDir ?? "lunora";

    // Each integration toggle is `boolean | options`: `false` opts out, `true`
    // (or omitted) means defaults, an object forwards its options.
    let cloudflareOption: false | CloudflarePluginOptions;

    if (input.cloudflare === false) {
        cloudflareOption = false;
    } else if (input.cloudflare === true || input.cloudflare === undefined) {
        cloudflareOption = {};
    } else {
        cloudflareOption = input.cloudflare;
    }

    return {
        allowUnauthenticatedShardAccess: input.allowUnauthenticatedShardAccess ?? false,
        apiSpec: input.apiSpec ?? "openapi",
        cloudflare: cloudflareOption,
        studio: input.studio ?? true,
        generatedDir: input.generatedDir ?? `${schemaDirectory}/_generated`,
        overlay: resolveOverlayOption(input.overlay),
        projectRoot: input.projectRoot ?? process.cwd(),
        schemaDir: schemaDirectory,
        validateWrangler: input.validateWrangler ?? true,
    };
};

/**
 * Lunora Vite plugin. Returns a flat array of Vite plugins that:
 *
 * 1. Run `@lunora/codegen` on startup + on schema file changes.
 * 2. Validate the project's `wrangler.jsonc` against the schema's implied bindings.
 * 3. Inject `@visulima/vite-overlay` for runtime error overlays (unless `overlay: false`).
 * 4. Include `@cloudflare/vite-plugin` so users get one-import setup (unless `cloudflare: false`).
 *
 * `@cloudflare/vite-plugin` and `@visulima/vite-overlay` are direct dependencies,
 * so they're imported statically — opt out per-feature via the options rather
 * than relying on whether they're installed.
 */
const lunora = (options?: LunoraPluginOptions): LunoraPlugins => {
    const resolved = resolveOptions(options);
    // Shared, mutable context threaded through every Lunora sub-plugin so the
    // detected meta-framework is computed once and readable downstream.
    const context = createPluginContext();
    // Captures `serve` vs `build` so the dev worker var below is injected only
    // in `vite`, never a production build. `enforce: "pre"` → captured first.
    const { isServe, plugin: commandProbe } = createCommandProbe();
    // `devVariablesPlugin` is `enforce: "pre"` + `apply: "serve"`: it offers to
    // scaffold `.dev.vars` before `@cloudflare/vite-plugin` boots the worker.
    // The framework-detect plugin runs early (its `config` hook) so the
    // detection result is available to later hooks; it's a no-op beyond a dev
    // log for the standalone (class-C) flow.
    const plugins: Plugin[] = [
        commandProbe,
        frameworkDetectPlugin(resolved, context),
        // Reads the detected framework off `context` and, for a class-A
        // framework (and only when the CF integration is on), resolves the
        // `virtual:lunora/worker` entry to a `composeWorker`-based worker that
        // routes `/_lunora/*` to Lunora and falls through to the framework SSR
        // handler — so the template never hand-wires `createWorker({ httpRouter })`.
        // A strict no-op for class-C and the `cloudflare: false` BYO path.
        frameworkComposePlugin(resolved, context),
        devVariablesPlugin(resolved),
        codegenPlugin(resolved),
        logStreamPlugin(),
        // Registers the running dev server in `.lunora/dev.json` so
        // `lunora dev --background|stop|status|logs` manage Vite projects too.
        devStatePlugin(resolved),
        agentRulesHintPlugin(resolved),
        // Catches the two silent dev-proxy misconfigurations (missing `ws: true`,
        // origin-rewriting `changeOrigin`) that leave live queries permanently
        // unconnected while HTTP RPC still answers.
        proxyCheckPlugin(),
    ];

    if (resolved.studio) {
        plugins.push(studioPlugin());
    }

    if (resolved.validateWrangler) {
        plugins.push(wranglerValidatorPlugin(resolved));
    }

    if (resolved.overlay !== false) {
        plugins.push(errorOverlayPlugin(resolved.overlay));
    }

    if (resolved.cloudflare !== false) {
        // Only the Cloudflare plugin builds + runs the dev containers, so tail
        // their logs only when it's active — the BYO (`cloudflare: false`) path
        // never starts containers, so Docker polling would be pointless.
        plugins.push(containerLogsPlugin(resolved));

        // Honor remote-binding dev (`LUNORA_REMOTE` / `lunora.json` `remote`) on
        // the `vite dev` path too, exactly like `lunora dev`: materialize a temp
        // wrangler config with `"remote": true` on each eligible binding and
        // point the cloudflare plugin's `configPath` at it. DO shards stay local.
        const remotePlan = planViteRemoteBindings({ projectRoot: resolved.projectRoot });

        // The dev worker env var (`WORKER_ENV=development`) is deferred correctly
        // inside its own `config` customizer; the remote `configPath` injection is
        // deferred to `remoteBindingsConfigPlugin`'s `config` hook below (the
        // resolved `serve`/`build` command is unknown at this factory-time call).
        const cloudflareOptions = withDevWorkerEnv(resolved.cloudflare, isServe);

        if (remotePlan.enabled) {
            if (remotePlan.configPath !== undefined) {
                // Register a cleanup that unlinks the temp config when the dev server closes.
                plugins.push(remoteBindingsCleanupPlugin(remotePlan.cleanup));
            }

            // Injects `configPath` at hook time (serve only) by mutating
            // `cloudflareOptions` in place before the cloudflare plugin reads it.
            plugins.push(remoteBindingsConfigPlugin(cloudflareOptions, remotePlan));
        }

        // Wrap the Cloudflare plugins' startup hooks so a Worker-entry evaluation
        // failure (e.g. a circular import in `lunora/`) surfaces an actionable
        // hint instead of a bare, file-less `runner-worker` TypeError.
        plugins.push(...withWorkerStartupHint(cloudflare(cloudflareOptions)));
    }

    return plugins;
};

// Read the real published version from the package manifest at load time rather
// than a hardcoded `"0.0.0"` (which lied to anyone introspecting the plugin for
// support diagnostics). `../package.json` resolves to this package's manifest
// from both `src/index.ts` (tsc/vitest) and the bundled `dist/index.mjs`.
const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export { default as codegenPlugin } from "./codegen-plugin";
export { default as containerLogsPlugin } from "./container-logs-plugin";
export type { ReconcileResult } from "./cron-sync";
export { reconcileWranglerCrons } from "./cron-sync";
export type { DetectedFramework, FrameworkClass, FrameworkDetection } from "./detect-framework";
export { detectFramework } from "./detect-framework";
export { default as devStatePlugin } from "./dev-state-plugin";
export { default as devVariablesPlugin } from "./dev-variables-plugin";
export { createCommandProbe, DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, withDevWorkerEnv } from "./dev-worker-env";
// Class-A composition surface. `LUNORA_WORKER_VIRTUAL_ID` is the virtual entry a
// class-A template points its wrangler `main` at (or re-exports) so the worker
// composing the framework SSR handler under `composeWorker`'s `httpRouter` seam
// is emitted by the plugin, not hand-wired. `buildWorkerEntrySource` /
// `isAutoComposable` / `CLASS_A_WIRING` are exported for the CLI + tests.
export type { ClassAWiring } from "./framework-compose-plugin";
export { buildWorkerEntrySource, CLASS_A_WIRING, frameworkComposePlugin, isAutoComposable, LUNORA_WORKER_VIRTUAL_ID } from "./framework-compose-plugin";
// The custom HMR event the codegen plugin sends on the client environment's hot
// channel after a successful codegen run (in place of a blanket browser reload).
export { default as LUNORA_API_UPDATED_EVENT } from "./hmr-events";
// `framework-detect-plugin` (the `LunoraPluginContext` bag + `createPluginContext`
// + the plugin itself) stays internal plumbing — it is wired into `lunora()`
// here and consumed only there + in tests until a second reader (PLAN4 M4
// composition) justifies a public surface. Only `detectFramework` (above) is public.
export { default as logStreamPlugin } from "./log-stream-plugin";
export { checkLunoraProxy, proxyCheckPlugin } from "./proxy-check-plugin";
export type { PlanViteRemoteOptions, ViteRemotePlan } from "./remote-bindings-plugin";
export { planViteRemoteBindings, remoteBindingsCleanupPlugin, remoteBindingsConfigPlugin, withRemoteBindings } from "./remote-bindings-plugin";
// The error→solution rule table itself lives in `@lunora/codegen` (shared with
// the standalone `lunora dev` CLI); `@lunora/vite` only wraps it as an overlay
// finder. Import `findLunoraSolution` / `LUNORA_SOLUTION_RULES` from `@lunora/codegen`.
export type { Solution, SolutionFinder } from "./solution-finders";
export { lunoraSolutionFinder, lunoraSolutionFinders } from "./solution-finders";
export { buildStudioUrl, STUDIO_PATH, studioPlugin } from "./studio-plugin";
export type { CloudflarePluginOptions, LunoraPluginOptions, LunoraPlugins, OverlayPluginOptions, ResolvedLunoraPluginOptions } from "./types";
export { augmentWorkerStartupError, isWorkerEntryEvalError, withWorkerStartupHint, WORKER_STARTUP_HINT } from "./worker-startup-hint";
export { wranglerValidatorPlugin } from "./wrangler-validator-plugin";
export { lunora, resolveOverlayOption, VERSION };
