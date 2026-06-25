import { cloudflare } from "@cloudflare/vite-plugin";
import errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

import agentRulesHintPlugin from "./agent-rules-hint-plugin";
import codegenPlugin from "./codegen-plugin";
import devVariablesPlugin from "./dev-variables-plugin";
import { createCommandProbe, withDevWorkerEnv } from "./dev-worker-env";
import { frameworkComposePlugin } from "./framework-compose-plugin";
import { createPluginContext, frameworkDetectPlugin } from "./framework-detect-plugin";
import logStreamPlugin from "./log-stream-plugin";
import { planViteRemoteBindings, remoteBindingsCleanupPlugin, withRemoteBindings } from "./remote-bindings-plugin";
import { studioPlugin } from "./studio-plugin";
import type { CloudflarePluginOptions, LunoraPluginOptions, LunoraPlugins, OverlayPluginOptions, ResolvedLunoraPluginOptions } from "./types";
import { withWorkerStartupHint } from "./worker-startup-hint";
import { wranglerValidatorPlugin } from "./wrangler-validator-plugin";

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

    // Forward both `error` AND `warn` console calls to the dev error overlay by
    // default (the overlay plugin's own default is `["error"]` only) — surfacing
    // Lunora's branded `warn` advisories in the browser too. User-overridable.
    const overlayDefaults = { forwardedConsoleMethods: ["error", "warn"] } satisfies Partial<OverlayPluginOptions>;
    let overlayOption: false | OverlayPluginOptions;

    if (input.overlay === false) {
        overlayOption = false;
    } else if (input.overlay === true || input.overlay === undefined) {
        overlayOption = { ...overlayDefaults };
    } else {
        overlayOption = { ...overlayDefaults, ...input.overlay };
    }

    return {
        apiSpec: input.apiSpec ?? "openapi",
        cloudflare: cloudflareOption,
        studio: input.studio ?? true,
        generatedDir: input.generatedDir ?? `${schemaDirectory}/_generated`,
        overlay: overlayOption,
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
        agentRulesHintPlugin(resolved),
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
        // Honor remote-binding dev (`LUNORA_REMOTE` / `lunora.json` `remote`) on
        // the `vite dev` path too, exactly like `lunora dev`: materialize a temp
        // wrangler config with `"remote": true` on each eligible binding and
        // point the cloudflare plugin's `configPath` at it. DO shards stay local.
        const remotePlan = planViteRemoteBindings({ projectRoot: resolved.projectRoot });

        if (remotePlan.enabled && remotePlan.configPath !== undefined) {
            // Register a cleanup that unlinks the temp config when the dev server closes.
            plugins.push(remoteBindingsCleanupPlugin(remotePlan.cleanup));
        }

        const cloudflareOptions = withRemoteBindings(withDevWorkerEnv(resolved.cloudflare, isServe), isServe, remotePlan);

        // Wrap the Cloudflare plugins' startup hooks so a Worker-entry evaluation
        // failure (e.g. a circular import in `lunora/`) surfaces an actionable
        // hint instead of a bare, file-less `runner-worker` TypeError.
        plugins.push(...withWorkerStartupHint(cloudflare(cloudflareOptions)));
    }

    return plugins;
};

const VERSION = "0.0.0";

export { default as codegenPlugin } from "./codegen-plugin";
export type { ReconcileResult } from "./cron-sync";
export { reconcileWranglerCrons } from "./cron-sync";
export type { DetectedFramework, FrameworkClass, FrameworkDetection } from "./detect-framework";
export { detectFramework } from "./detect-framework";
export { default as devVariablesPlugin } from "./dev-variables-plugin";
export { createCommandProbe, DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, withDevWorkerEnv } from "./dev-worker-env";
// Class-A composition surface. `LUNORA_WORKER_VIRTUAL_ID` is the virtual entry a
// class-A template points its wrangler `main` at (or re-exports) so the worker
// composing the framework SSR handler under `composeWorker`'s `httpRouter` seam
// is emitted by the plugin, not hand-wired. `buildWorkerEntrySource` /
// `isAutoComposable` / `CLASS_A_WIRING` are exported for the CLI + tests.
export type { ClassAWiring } from "./framework-compose-plugin";
export { buildWorkerEntrySource, CLASS_A_WIRING, frameworkComposePlugin, isAutoComposable, LUNORA_WORKER_VIRTUAL_ID } from "./framework-compose-plugin";
// `framework-detect-plugin` (the `LunoraPluginContext` bag + `createPluginContext`
// + the plugin itself) stays internal plumbing — it is wired into `lunora()`
// here and consumed only there + in tests until a second reader (PLAN4 M4
// composition) justifies a public surface. Only `detectFramework` (above) is public.
export { default as logStreamPlugin } from "./log-stream-plugin";
export type { PlanViteRemoteOptions, ViteRemotePlan } from "./remote-bindings-plugin";
export { planViteRemoteBindings, remoteBindingsCleanupPlugin, withRemoteBindings } from "./remote-bindings-plugin";
export { buildStudioUrl, STUDIO_PATH, studioPlugin } from "./studio-plugin";
export type { CloudflarePluginOptions, LunoraPluginOptions, LunoraPlugins, OverlayPluginOptions, ResolvedLunoraPluginOptions } from "./types";
export { augmentWorkerStartupError, isWorkerEntryEvalError, withWorkerStartupHint, WORKER_STARTUP_HINT } from "./worker-startup-hint";
export { wranglerValidatorPlugin } from "./wrangler-validator-plugin";
export { lunora, VERSION };
