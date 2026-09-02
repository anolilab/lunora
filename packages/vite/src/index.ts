import { createRequire } from "node:module";

import { cloudflare } from "@cloudflare/vite-plugin";
import { isRunnableTarget, resolveTargetOrThrow, runnableTargetIds } from "@lunora/config";
import errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

import agentRulesHintPlugin from "./agent-rules-hint-plugin";
import { codegenPlugin } from "./codegen-plugin";
import containerLogsPlugin from "./container-logs-plugin";
import devStatePlugin from "./dev-state-plugin";
import { devVariablesPlugin } from "./dev-variables-plugin";
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

/**
 * `resolveTargetOrThrow`, plus the check that the resolved target is one this
 * plugin can actually run.
 *
 * `isRunnableTarget` is the shared predicate the CLI's `deploy`/`dev` guard
 * uses too, so the two cannot drift. `resolveTargetOrThrow` accepts a
 * codegen-only target like `node` — legitimately, since generating for it is
 * meaningful — so without this check the plugin would go on to run the
 * **Cloudflare** build pipeline against it and emit the wrong surface silently.
 */
const resolveRunnableTargetOrThrow = (projectRoot: string, explicit?: string): string => {
    const target = resolveTargetOrThrow(projectRoot, explicit);

    if (!isRunnableTarget(target)) {
        const runnable = runnableTargetIds();

        throw new Error(
            `target "${target}" has no command-line toolchain, so the Lunora Vite plugin cannot build or serve it — it can only generate for it (\`lunora codegen --target ${target}\`). Buildable targets: ${runnable.join(", ")}`,
        );
    }

    return target;
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

    const projectRoot = input.projectRoot ?? process.cwd();

    return {
        allowUnauthenticatedShardAccess: input.allowUnauthenticatedShardAccess ?? false,
        apiSpec: input.apiSpec ?? "openapi",
        cloudflare: cloudflareOption,
        studio: input.studio ?? true,
        // Derived, never taken from `input`: codegen always writes
        // `<schemaDir>/_generated`, so this is the only value that can be true —
        // eslint-disable-next-line no-secrets/no-secrets -- false positive: a function name referenced in a comment, not a credential.
        // and `frameworkComposePlugin` uses it as the composed worker's import base.
        generatedDir: `${schemaDirectory}/_generated`,
        overlay: resolveOverlayOption(input.overlay),
        projectRoot,
        schemaDir: schemaDirectory,
        // The only route a class-A app has to `createShardDO(config)` — it has no
        // worker entry of its own to pass one from. See `LunoraShardConfig`.
        shard: input.shard ?? {},
        // Same resolution AND validation as the CLI — explicit option, then
        // `lunora.json`, then the default — so a project that sets `target`
        // once gets it in `vite build` and `lunora deploy` alike, and a typo
        // fails here rather than emitting the default surface silently.
        target: resolveRunnableTargetOrThrow(projectRoot, input.target),
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
    // `devVariablesPlugin` is `enforce: "pre"` + `apply: "serve"`: it offers to
    // scaffold `.dev.vars` before `@cloudflare/vite-plugin` boots the worker.
    // The framework-detect plugin runs early (its `config` hook) so the
    // detection result is available to later hooks; it's a no-op beyond a dev
    // log for the standalone (class-C) flow.
    const plugins: Plugin[] = [
        frameworkDetectPlugin(resolved, context),
        // Reads the detected framework off `context` and, for a class-A
        // framework, resolves the `virtual:lunora/worker` entry to a
        // `composeWorker`-based worker that routes `/_lunora/*` to Lunora and
        // falls through to the framework SSR handler — so the template never
        // hand-wires `createWorker({ httpRouter })`. A no-op for class-C only:
        // the `cloudflare: false` BYO path still resolves the virtual entry (the
        // vinext template's wrangler `main` points at it), because who adds the
        // Cloudflare plugin says nothing about who composes the worker.
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
        plugins.push(studioPlugin(resolved));
    }

    if (resolved.validateWrangler) {
        plugins.push(wranglerValidatorPlugin(resolved));
    }

    if (resolved.overlay !== false) {
        plugins.push(errorOverlayPlugin(resolved.overlay));
    }

    // Docker runs the dev containers for whoever started them, so tailing their
    // logs is independent of WHO added the Cloudflare plugin. Under
    // `cloudflare: false` the project adds it itself and still runs containers —
    // gating this on the option left that path with silent containers. A project
    // that declares none never imports `dockerode` either way.
    plugins.push(containerLogsPlugin(resolved));

    // Honor remote-binding dev (`LUNORA_REMOTE` / `lunora.json` `remote`) on the
    // `vite dev` path too, exactly like `lunora dev`: materialize a temp wrangler
    // config with `"remote": true` on each eligible binding. DO shards stay local.
    const remotePlan = planViteRemoteBindings({ projectRoot: resolved.projectRoot });

    if (remotePlan.enabled && remotePlan.configPath !== undefined) {
        // Register a cleanup that unlinks the temp config when the dev server closes.
        plugins.push(remoteBindingsCleanupPlugin(remotePlan.cleanup));
    }

    // The Cloudflare plugin Lunora adds, or `undefined` on the BYO path — where
    // the same plugin reports the materialized config instead of injecting it.
    const cloudflareOptions = resolved.cloudflare === false ? undefined : { ...resolved.cloudflare };

    if (remotePlan.enabled) {
        // Injects `configPath` at hook time (serve only) by mutating
        // `cloudflareOptions` in place before the cloudflare plugin reads it —
        // the resolved `serve`/`build` command is unknown at this factory-time call.
        plugins.push(remoteBindingsConfigPlugin(cloudflareOptions, remotePlan));
    }

    if (cloudflareOptions !== undefined) {
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

export { codegenPlugin } from "./codegen-plugin";
export { default as containerLogsPlugin } from "./container-logs-plugin";
export type { ReconcileResult } from "./cron-sync";
export { reconcileWranglerCrons } from "./cron-sync";
export type { DetectedFramework, FrameworkClass, FrameworkDetection } from "./detect-framework";
export { detectFramework } from "./detect-framework";
export { default as devStatePlugin } from "./dev-state-plugin";
export { DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, devVariablesPlugin } from "./dev-variables-plugin";
// Class-A composition surface. `LUNORA_WORKER_VIRTUAL_ID` is the virtual entry a
// class-A template points its wrangler `main` at (or re-exports) so the worker
// composing the framework SSR handler under `composeWorker`'s `httpRouter` seam
// is emitted by the plugin, not hand-wired. `buildWorkerEntrySource` /
// `isAutoComposable` / `CLASS_A_WIRING` are exported for the CLI + tests.
export type { ClassAWiring, GeneratedClassModule } from "./framework-compose-plugin";
export {
    buildWorkerEntrySource,
    CLASS_A_WIRING,
    frameworkComposePlugin,
    GENERATED_CLASS_MODULES,
    isAutoComposable,
    LUNORA_WORKER_VIRTUAL_ID,
} from "./framework-compose-plugin";
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
export type {
    CloudflarePluginOptions,
    LunoraPluginOptions,
    LunoraPlugins,
    LunoraShardConfig,
    OverlayPluginOptions,
    ResolvedLunoraPluginOptions,
} from "./types";
export { augmentWorkerStartupError, isWorkerEntryEvalError, withWorkerStartupHint, WORKER_STARTUP_HINT } from "./worker-startup-hint";
export { wranglerValidatorPlugin } from "./wrangler-validator-plugin";
export { lunora, resolveOverlayOption, VERSION };
