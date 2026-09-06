import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import type { CodegenResult } from "@lunora/codegen";
import { CodegenDiagnosticError, createCodegenProject, describeErrorLevelFindings, findTsconfig, refreshCodegenProject, runCodegen } from "@lunora/codegen";
import { CODEGEN_ENV, inferLunoraBindings, isCodegenDisabled, LUNORA_CONFIG_FILE, runPostCodegenHook } from "@lunora/config";
import type { ExportGap } from "@lunora/config/cloudflare";
import { collectWranglerSecretVariables, reconcileWranglerBindings, reconcileWranglerCompatibilityDate, WRANGLER_FILES } from "@lunora/config/cloudflare";
import type { Project } from "ts-morph";
import type { Plugin, ViteDevServer } from "vite";
import { isRunnableDevEnvironment } from "vite";

import { computeConfigFingerprint } from "./config-fingerprint";
import { reconcileWranglerCrons } from "./cron-sync";
import LUNORA_API_UPDATED_EVENT from "./hmr-events";
import { advisoryLine, LUNORA_TAG } from "./log";
import { createRegenerateScheduler, HOOK_SETTLE_MS } from "./regenerate-scheduler";
import fingerprintSchemaSources from "./schema-fingerprint";
import type { PendingCloseMap } from "./server-close";
import { registerDevServerClose, runPendingClose } from "./server-close";
import type { ResolvedLunoraPluginOptions } from "./types";

/** Matches a project-variant tsconfig filename (`tsconfig.build.json`, …). */
const TSCONFIG_VARIANT_RE = /[/\\]tsconfig\..+\.json$/u;

/**
 * Compose the dev error-overlay message for declared-but-not-re-exported
 * containers/workflows. These would otherwise fail only at `wrangler deploy`
 * (which rejects a `class_name` the worker doesn't export); surfacing the precise
 * fix in the browser overlay turns a late deploy failure into an immediate,
 * actionable dev-time error.
 */
const formatExportGapOverlay = (gaps: ReadonlyArray<ExportGap>): string => {
    const lines = gaps.map((gap) => `  • ${gap.kind} "${gap.exportName}" — class ${gap.className} is not exported by your worker entry.`);
    const hints = [...new Set(gaps.map((gap) => gap.module))].map((module) => `  export * from "./lunora/_generated/${module}";`);

    return [
        `[lunora] ${String(gaps.length)} declared ${gaps.length === 1 ? "binding is" : "bindings are"} not exported by your worker entry — \`wrangler deploy\` will fail.`,
        ...lines,
        "",
        "Add to your worker entry:",
        ...hints,
    ].join("\n");
};

/**
 * Infer the Cloudflare bindings the project's code implies and reconcile them
 * into `wrangler.jsonc` (Durable Objects, their migration classes, and the
 * `DB` D1 binding for `.global()` schemas). Best-effort and idempotent — runs
 * once at startup so the user never hand-writes binding boilerplate. A failure
 * here must never abort codegen; the wrangler validator reports real problems.
 *
 * `onExportGaps` (dev only) is invoked when a declared container/workflow isn't
 * re-exported by the worker entry, so the caller can raise it in the browser
 * error overlay in addition to the console warning.
 */
const reconcileBindingsSafely = async (
    options: Pick<ResolvedLunoraPluginOptions, "projectRoot" | "schemaDir">,
    logger: { info?: (message: string) => void; warn: (message: string) => void },
    onExportGaps?: (gaps: ReadonlyArray<ExportGap>) => void,
): Promise<void> => {
    try {
        const inferred = await inferLunoraBindings({ projectRoot: options.projectRoot, schemaDir: options.schemaDir });
        const reconciled = reconcileWranglerBindings(options.projectRoot, inferred);

        if (reconciled.changed) {
            logger.info?.(`${LUNORA_TAG} inferred bindings → ${reconciled.added.join(", ")} (written to ${reconciled.wranglerPath ?? "wrangler.jsonc"})`);
        }

        for (const warning of reconciled.warnings) {
            logger.warn(`${LUNORA_TAG} ${warning}`);
        }

        if (reconciled.exportGaps.length > 0) {
            onExportGaps?.(reconciled.exportGaps);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`${LUNORA_TAG} binding inference skipped: ${message}`);
    }
};

/** Callbacks injected from the dev-server context into {@link runCodegenSafely}. */
interface OverlayCallbacks {
    /** Called on fatal codegen failure to push the error into the browser overlay. */
    onError: (error: unknown, message: string) => void;
}

/**
 * Reconcile cron triggers and compatibility date into wrangler.jsonc.
 * Extracted to keep {@link runCodegenSafely}'s cognitive complexity bounded.
 */
const reconcileWranglerExtras = (
    projectRoot: string,
    cronTriggers: ReadonlyArray<string>,
    logger: { info?: (message: string) => void; warn: (message: string) => void },
): void => {
    try {
        const reconciled = reconcileWranglerCrons(projectRoot, cronTriggers);

        if (reconciled.changed) {
            logger.info?.(`${LUNORA_TAG} synced ${cronTriggers.length.toFixed(0)} cron trigger(s) into ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }

        // The array is not the codegen-derived set — see the deploy handler.
        if (reconciled.preserved.length > 0) {
            logger.info?.(`${LUNORA_TAG} kept ${reconciled.preserved.length.toFixed(0)} hand-written cron trigger(s): ${reconciled.preserved.join(", ")}`);
        }
    } catch (cronError: unknown) {
        const message = cronError instanceof Error ? cronError.message : String(cronError);

        logger.warn(`${LUNORA_TAG} cron trigger sync skipped: ${message}`);
    }

    try {
        const reconciled = reconcileWranglerCompatibilityDate(projectRoot);

        if (reconciled.changed) {
            logger.info?.(
                `${LUNORA_TAG} bumped compatibility_date to ${reconciled.date ?? "unknown"} (Workers Cache enabled) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`,
            );
        }
    } catch (dateError: unknown) {
        const message = dateError instanceof Error ? dateError.message : String(dateError);

        logger.warn(`${LUNORA_TAG} compatibility date sync skipped: ${message}`);
    }
};

/** {@link runCodegenSafely}'s result. */
interface CodegenSafelyResult {
    /**
     * Set when codegen reported at least one ERROR-level advisory or
     * platform diagnostic — one message aggregating all of them, ready to
     * fail a `vite build` with. Every level is still logged unconditionally
     * above; this is only the caller's signal for whether to escalate.
     */
    blockingMessage?: string;

    /**
     * Set when codegen THREW — the schema could not be parsed/emitted at all.
     * The hardest failure signal this function has, and (like
     * {@link CodegenSafelyResult.blockingMessage}) only the caller's escalation
     * signal: the message is logged and pushed to the overlay regardless.
     *
     * Distinct from a merely absent `outputDirectory`, which also covers the
     * benign "no schema.ts yet" case an uninitialised project is in at
     * `buildStart` — that one must stay non-fatal.
     */
    failure?: string;
    /** Absolute directory codegen actually wrote to; `undefined` when codegen was skipped or failed. */
    outputDirectory?: string;
}

/**
 * The `blockingMessage` for {@link runCodegenSafely}'s result: one aggregated
 * line naming every ERROR-level advisory/platform diagnostic, or `undefined`
 * when none. The name list itself comes from `@lunora/codegen`'s
 * `describeErrorLevelFindings` — the same filter+dedup+sort the CLI's
 * `lunora codegen`/`lunora deploy` gate uses — so this only owns folding the
 * two categories into one combined, sorted message; it used to compute an
 * unsorted list inline, which is what let it drift from the CLI's. Extracted
 * purely to keep `runCodegenSafely`'s cognitive complexity within the repo's
 * lint budget — no other behavior change from inlining it.
 */
const buildBlockingMessage = (result: Pick<CodegenResult, "advisories" | "platformDiagnostics">): string | undefined => {
    const { advisoryNames, platformDiagnosticNames } = describeErrorLevelFindings(result);
    const blockingNames = [...new Set([...advisoryNames, ...platformDiagnosticNames])].toSorted((a, b) => a.localeCompare(b));

    if (blockingNames.length === 0) {
        return undefined;
    }

    const noun = blockingNames.length === 1 ? "advisory/platform diagnostic" : "advisories/platform diagnostics";

    return `${LUNORA_TAG} ${String(blockingNames.length)} ERROR-level ${noun} (${blockingNames.join(", ")}) — see the log above for detail.`;
};

/**
 * Report a missing `schema.ts`, and — only on a watch-triggered run — escalate
 * it to the overlay. Extracted to keep {@link runCodegenSafely}'s cognitive
 * complexity within the repo's lint budget — no other behavior change from
 * inlining it.
 *
 * `overlay` is only ever passed on a watch-triggered run (the debounced
 * `onChange` callback in `configureServer`) — `buildStart` always calls
 * {@link runCodegenSafely} with `overlay` omitted, for both `vite build` and
 * `vite dev`. So its presence here IS the "just lost one" signal: at
 * `buildStart` a missing schema.ts is the normal state of an uninitialised
 * project (no `lunora init` yet, or a non-Lunora project) and must stay
 * silent beyond the warning. During a watch session it means schema.ts
 * disappeared out from under previously-generated output — `_generated/*`
 * now references a file that no longer exists — so surface it the same way
 * every other codegen failure in this function reaches the overlay.
 */
const reportMissingSchema = (schemaPath: string, logger: { warn: (message: string) => void }, overlay: OverlayCallbacks | undefined): void => {
    logger.warn(`${LUNORA_TAG} schema.ts not found at ${schemaPath} — codegen skipped`);

    if (overlay !== undefined) {
        const message = `schema.ts not found at ${schemaPath} — generated output is now stale`;

        overlay.onError(new Error(message), message);
    }
};

/**
 * Run codegen, returning the absolute directory codegen actually wrote to
 * (so callers can invalidate the *real* output, not an independently-guessed
 * path) and — when any advisory/platform diagnostic is ERROR-level — an
 * aggregated `blockingMessage` the caller can escalate.
 *
 * Pass `overlay` to surface fatal failures in the Vite error overlay during
 * dev. Omit it (build mode) to keep the current log-and-return behaviour.
 */
const runCodegenSafely = (
    options: Pick<ResolvedLunoraPluginOptions, "apiSpec" | "projectRoot" | "schemaDir" | "target">,
    logger: { error: (message: string) => void; info?: (message: string) => void; warn: (message: string) => void },
    overlay?: OverlayCallbacks,
    project?: Project,
): CodegenSafelyResult => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        reportMissingSchema(schemaPath, logger, overlay);

        return {};
    }

    try {
        const result = runCodegen({
            apiSpec: options.apiSpec,
            lunoraDirectory: options.schemaDir,
            project,
            projectRoot: options.projectRoot,
            target: options.target,
            wranglerVariables: collectWranglerSecretVariables(options.projectRoot),
        });

        reconcileWranglerExtras(options.projectRoot, result.cronTriggers, logger);

        // Surface static schema advisories (unindexed FKs, …) in the dev/build
        // log. Codegen returns them without printing; the richer error-overlay
        // presentation is a later step.
        for (const advisory of result.advisories) {
            const line = advisoryLine(advisory.level, advisory.name, advisory.detail, advisory.remediation);

            if (advisory.level === "ERROR") {
                logger.error(line);
            } else {
                logger.warn(line);
            }
        }

        // Platform-portability diagnostics: a `ctx.*` surface the target cannot
        // provide, or a target with no registered capability matrix. Surfaced
        // here for the same reason the CLI surfaces them — without this a
        // `vite build` against a mis-declared target emits the default surface,
        // prints nothing, and exits 0, which is the Vite-first path around the
        // guard the CLI already has.
        for (const diagnostic of result.platformDiagnostics) {
            const line = advisoryLine(diagnostic.level === "error" ? "ERROR" : "WARN", diagnostic.name, diagnostic.message, diagnostic.remediation);

            if (diagnostic.level === "error") {
                logger.error(line);
            } else {
                logger.warn(line);
            }
        }

        // Codegen succeeded. The browser error overlay (if any was shown) is
        // cleared by the single `full-reload` the change handler sends after a
        // successful run — so there is nothing to do here. (Build mode passes no
        // overlay at all.)

        // Every level above is already logged; this only decides whether the
        // caller escalates. `vite build` gates on it (same reason `lunora
        // deploy` does: an ERROR advisory says a call throws at runtime, and a
        // platform diagnostic says the emitted surface doesn't match the
        // target) — `vite dev` never does, matching `lunora codegen`'s own
        // advisory-outside-CI default.
        return {
            blockingMessage: buildBlockingMessage(result),
            outputDirectory: resolve(result.outputDirectory),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`${LUNORA_TAG} codegen failed: ${message}`);

        // In dev mode, surface the failure in the browser error overlay so the
        // user sees it immediately without leaving the browser.
        overlay?.onError(error, message);

        return { failure: `${LUNORA_TAG} codegen failed: ${message}` };
    }
};

/**
 * Notify the dev environments after a successful codegen run — replacing the old
 * single, blanket browser `full-reload` that dropped every open WebSocket
 * subscription, optimistic-mutation layer, offline-queue entry, and form field
 * on every schema save (the worst default for a real-time framework).
 *
 * Non-runnable worker environments (workerd, run by `@cloudflare/vite-plugin`,
 * for which {@link isRunnableDevEnvironment} returns `false`) still get a scoped
 * `full-reload` on their own hot channel: the build-side `invalidateModule` loop
 * alone does not evict the remote runner's evaluated-module cache, so the worker
 * would keep serving the previous `_generated/*`. The scoped reload makes the
 * runner drop its cache and re-evaluate the fresh generated code. Astro uses the
 * same idiom for Cloudflare's workerd.
 *
 * The client/browser environment (always named `client`) is NOT reloaded. Vite's
 * granular module HMR already re-imports the changed `_generated/*` in place, and
 * the worker reload bounces the socket so the client's reconnect path
 * re-subscribes with fresh server behaviour — all without a page reload. We emit
 * a scoped custom event ({@link LUNORA_API_UPDATED_EVENT}) as a non-destructive
 * hook instead. The one exception is `clearErrorOverlay`: when this run recovers
 * from a codegen error overlay, the client is reloaded once so the overlay is
 * cleared — a rare broken-to-fixed transition where a reload is expected, not a
 * per-keystroke one.
 *
 * Falls back to a browser `full-reload` only when there is genuinely no client
 * environment.
 */
const notifyEnvironmentsAfterCodegen = (server: ViteDevServer, changedFile: string, clearErrorOverlay: boolean): void => {
    // The value type of the `environments` record — captured so the client env
    // can be tracked as possibly-absent (defensive; Vite always registers one).
    let clientEnvironment: (typeof server.environments)[string] | undefined;

    for (const [name, environment] of Object.entries(server.environments)) {
        if (name === "client") {
            clientEnvironment = environment;

            continue;
        }

        // A runnable (Node SSR) environment re-evaluates on its next request off
        // the invalidated module graph, so it needs no reload signal.
        if (isRunnableDevEnvironment(environment)) {
            continue;
        }

        // Non-runnable, non-client → the workerd worker: evict its runner cache.
        environment.hot.send({ path: "*", triggeredBy: changedFile, type: "full-reload" });
    }

    if (clientEnvironment === undefined) {
        // No client environment at all — fall back to a browser reload.
        server.hot.send({ type: "full-reload" });

        return;
    }

    if (clearErrorOverlay) {
        clientEnvironment.hot.send({ type: "full-reload" });

        return;
    }

    clientEnvironment.hot.send({ event: LUNORA_API_UPDATED_EVENT, type: "custom" });
};

/**
 * Vite plugin that runs `@lunora/codegen` on startup and on file changes
 * inside the lunora schema directory.
 */
const codegenPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    const absoluteSchemaDirectory = resolve(options.projectRoot, options.schemaDir);

    // Read once, at construction: the env cannot change under a running server,
    // and both consumers below (the dev-only `buildStart` skip and the watcher
    // registration) must agree on one answer.
    const codegenDisabled = isCodegenDisabled(process.env[CODEGEN_ENV]);

    // Seed from the resolved option (itself derived as `<schemaDir>/_generated`,
    // the only path codegen writes), then treat codegen's returned output dir as
    // authoritative once it has run — so the change-guard and the invalidation
    // loop below can never target a directory nothing writes.
    let absoluteGeneratedDirectory = resolve(options.projectRoot, options.generatedDir);

    // When the project's `postcodegen` last finished, and whether one is running
    // right now — see {@link HOOK_SETTLE_MS}. Plugin-scoped, not server-scoped:
    // `buildStart` runs the hook too, and the watcher registered in
    // `configureServer` has to ignore what that one wrote.
    let hookSettledAt = 0;
    let hookRunning = false;

    // Captured in configureServer and used to push overlay events. Undefined in
    // build mode (vite build) — the overlay callbacks are never wired up then.
    let devServer: ViteDevServer | undefined;

    // Teardown callbacks pending a middleware-mode dev-server close (no
    // httpServer to hang a "close" listener on) — see `server-close.ts` for
    // the middleware/`buildEnd` mechanics and the restart-race rationale.
    // Without this, a pending debounce could still run codegen against a
    // torn-down module graph, and the cached ts-morph Project + timer would
    // leak past the server's life.
    const pendingMiddlewareTeardowns: PendingCloseMap = new Map();

    // --- Config-drift auto-restart state (see the config watcher in
    // configureServer) --- Lives at the plugin-factory scope so it survives a
    // `server.restart()` (Vite re-invokes the hooks on the SAME plugin instance).
    //
    // `configFingerprint` is the binding-relevant baseline of wrangler.jsonc +
    // lunora.json, refreshed after every Lunora-initiated config write so codegen's
    // own idempotent rewrites never look like drift. `restartInFlight` collapses a
    // burst of edits during the async restart window into one restart.
    //
    // `configBaselineSettled` is false during the startup window — from
    // configureServer setting the baseline until buildStart finishes its own
    // binding-provisioning write and re-baselines. While unsettled, a config
    // event just adopts the new baseline instead of restarting, so the initial
    // `reconcileBindings` write (or a restart's own reconcile) can't race the
    // watcher into a spurious mid-boot restart. Reset each configureServer so a
    // `server.restart()` re-guards its fresh boot window.
    let configFingerprint: string | undefined;
    let configBaselineSettled = false;
    let restartInFlight = false;

    // Captured via the `config` hook (fires before `buildStart`), same idiom as
    // `createCommandProbe` in `dev-worker-env.ts`. `buildStart` runs for BOTH
    // `vite build` and `vite dev` — the presence/absence of the `overlay`
    // callbacks below is NOT a build/dev signal (build mode's `buildStart` call
    // also omits it), so without this a `vite build` against a mis-declared
    // target logs an ERROR line and still exits 0.
    let command: "build" | "serve" | undefined;

    return {
        config(_userConfig, env) {
            command = env.command;
        },
        async buildStart() {
            const logger = {
                error: (message: string): void => {
                    // eslint-disable-next-line no-console
                    console.error(message);
                },
                info: (message: string): void => {
                    // eslint-disable-next-line no-console
                    console.info(message);
                },
                warn: (message: string): void => {
                    // eslint-disable-next-line no-console
                    console.warn(message);
                },
            };

            // Build mode: no devServer, no overlay callbacks.
            //
            // {@link isCodegenDisabled} is a DEV switch, honoured only in serve mode:
            // `vite build` must keep generating, because the escalation below is the
            // only thing that fails a build on an ERROR-level advisory or platform
            // diagnostic. Skipping generation would skip that gate too — an app
            // shipping against a surface its target cannot serve, CI green the whole
            // way, from a variable someone exported in a shell profile.
            const skipCodegen = command !== "build" && codegenDisabled;
            const { blockingMessage, failure, outputDirectory } = skipCodegen ? {} : runCodegenSafely(options, logger);

            // Codegen threw: the schema could not be parsed or emitted at all.
            // Without this a `vite build` went on to bundle whatever `_generated/*`
            // the last good run left on disk — a schema typo in CI exited 0 and
            // shipped types and routes for a schema that no longer exists. Failing
            // here is the same policy the ERROR-advisory escalation below applies to
            // a strictly SOFTER signal; dev stays log-only (the overlay already
            // reported it) for the same reason it does there.
            if (command === "build" && failure !== undefined) {
                this.error(failure);
            }

            if (outputDirectory !== undefined) {
                absoluteGeneratedDirectory = outputDirectory;

                // The project's own post-generation step, exactly as `lunora
                // build`/`prepare`/`deploy` run it. A Vite project's codegen is
                // owned here, so without this its `postcodegen` never ran at all
                // and `vite build` shipped output the project considers
                // unfinished. Only after a run that produced output — a hook over
                // a tree codegen did not write edits the previous run's files.
                //
                // `hookRunning` (not just the settle window) for the whole call:
                // the window is armed only once the hook RESOLVES, so a hook that
                // writes early and runs longer than it would leave its own event
                // unfiltered for the watcher `configureServer` registers.
                hookRunning = true;

                let hook;

                try {
                    hook = await runPostCodegenHook({ cwd: options.projectRoot, logger });
                } finally {
                    hookRunning = false;
                }

                // Armed only when a hook actually RAN. Arming it on every
                // regeneration would deafen the watcher for the window after each
                // one — dropping real saves, in every project that declares no
                // `postcodegen`, which is nearly all of them.
                if (hook.ran) {
                    hookSettledAt = Date.now();
                }

                // A build must not ship output the project's own post-step could
                // not finish — the same reason `lunora build`/`deploy` abort on it,
                // and the whole point of running the hook here. Dev stays
                // log-only (the hook already reported), matching the advisory
                // policy one branch below: interrupting the dev server on a hook
                // the next save may fix is the worse loop.
                if (command === "build" && hook.error !== undefined) {
                    this.error(hook.error);
                }
            }

            // `vite build` fails on an ERROR-level advisory/platform diagnostic —
            // silence here is how an app ships built against a surface its target
            // can't serve, or a call known to throw at runtime, with CI green the
            // whole way (the same gap `lunora deploy` closed for the CLI path).
            // `vite dev` stays log-only, matching `lunora codegen`'s own
            // advisory-outside-CI default — interrupting the dev server on every
            // ERROR-level advisory would be a worse loop than the terminal warning.
            if (command === "build" && blockingMessage !== undefined) {
                this.error(blockingMessage);
            }

            // Auto-provision the bindings the code implies. Done once at startup
            // (not on every schema edit): bindings change rarely and a restart
            // picks up a newly-added capability. In dev, a declared-but-not-
            // re-exported container/workflow is raised in the browser error
            // overlay (Vite buffers it and replays to clients on connect) so the
            // fix surfaces here rather than at a late `wrangler deploy` failure.
            await reconcileBindingsSafely(options, logger, (gaps) => {
                devServer?.hot.send({
                    err: { loc: undefined, message: formatExportGapOverlay(gaps), stack: "" },
                    type: "error",
                });
            });

            // Re-baseline the config-drift fingerprint AFTER our own binding write,
            // so the watcher event for that write is absorbed instead of read as an
            // external edit (which would restart the just-started server). Dev only
            // — build mode has no watcher. buildStart runs after configureServer, so
            // this supersedes the baseline captured there. Marking the baseline
            // settled closes the startup window: any binding-write event still
            // queued from `reconcileBindings` now matches this baseline (or is
            // absorbed by the unsettled guard if it arrives before this line).
            if (devServer !== undefined) {
                configFingerprint = computeConfigFingerprint(options.projectRoot);
                configBaselineSettled = true;
            }
        },
        configureServer(server: ViteDevServer) {
            devServer = server;

            server.watcher.add(absoluteSchemaDirectory);

            // Baseline the config-drift fingerprint from the current on-disk state
            // before any watcher event can fire (buildStart re-baselines it after
            // its binding write). See the config watcher wired at the end of this
            // hook and `computeConfigFingerprint` for the anti-loop rationale.
            // `configBaselineSettled` reopens the startup window: until buildStart
            // finishes its reconcile+re-baseline, config events only adopt (never
            // restart), so this hook's own boot — and a `server.restart()`'s —
            // can't restart on its own binding-provisioning write.
            configFingerprint = computeConfigFingerprint(options.projectRoot);
            configBaselineSettled = false;

            // Reuse the dev server's logger for codegen output. Declared here
            // (not inside the debounced callback) so the arrow bodies don't nest
            // past the lint depth limit.
            const serverLogger = {
                error: (message: string): void => {
                    server.config.logger.error(message);
                },
                info: (message: string): void => {
                    server.config.logger.info(message);
                },
                warn: (message: string): void => {
                    server.config.logger.warn(message);
                },
            };

            // True while a codegen error overlay is showing in the browser, so
            // the next *successful* run knows to reload the client once to clear
            // it (see `notifyEnvironmentsAfterCodegen`). Normal saves never set
            // this, so they stay non-destructive.
            let hadErrorOverlay = false;

            // Overlay callbacks: push failures to the browser and clear on recovery.
            const overlay: OverlayCallbacks = {
                onError(error, message) {
                    hadErrorOverlay = true;

                    // `CodegenDiagnosticError` carries the exact source location;
                    // for plain errors the location is unavailable in the overlay
                    // — steer the user to the terminal where the full stack is logged.
                    const loc = error instanceof CodegenDiagnosticError ? { column: error.column, file: error.file, line: error.line } : undefined;
                    const overlayMessage =
                        loc === undefined
                            ? `[lunora] codegen failed: ${message}\n(see terminal for full stack trace and file location)`
                            : `[lunora] codegen failed: ${message}`;

                    devServer?.hot.send({
                        err: {
                            loc,
                            message: overlayMessage,
                            stack: error instanceof Error ? (error.stack ?? "") : "",
                        },
                        type: "error",
                    });
                },
            };

            // True only for the directory itself or a real descendant — a bare
            // `startsWith` would also match a sibling whose name shares the
            // prefix (e.g. `lunora-foo/` for schemaDir `lunora`).
            const isInside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory + sep);

            // Set once the server is torn down so a debounced callback that fires
            // after `close` no-ops instead of writing to a dead ws/module graph.
            let closed = false;

            // The reused ts-morph Project. Built on first codegen run and refreshed
            // from disk on each subsequent one, so the dev-loop never re-parses the
            // user's whole TS program per save. Dropped (rebuilt next run) whenever
            // a tsconfig changes, on ANY codegen error (so a corrupted cache can't
            // wedge the loop), and on server close.
            let cachedProject: Project | undefined;

            // Invalidate generated modules across every environment's module graph
            // so the dev server picks up new types/values. `@cloudflare/vite-plugin`
            // runs the worker (and SSR) in their own Vite environments, each with
            // its own graph the client graph doesn't cover — `server.environments`
            // is always present on Vite 8 (the plugin's peer), so walk them all.
            const invalidateGenerated = (): void => {
                for (const environment of Object.values(server.environments)) {
                    const graph = environment.moduleGraph;

                    for (const moduleEntry of graph.idToModuleMap.values()) {
                        if (moduleEntry.id && isInside(moduleEntry.id, absoluteGeneratedDirectory)) {
                            // Invalidate via the owning environment graph so each
                            // environment re-pulls the regenerated module.
                            graph.invalidateModule(moduleEntry);
                        }
                    }
                }
            };

            /**
             * One debounced regeneration: refresh the cached Project, run codegen,
             * run the project's `postcodegen`, then tell the client.
             *
             * A named function rather than the timer callback's body so the timer
             * stays synchronous (`setTimeout` cannot await) and so the nesting here
             * stops one level short of the depth limit. Never rejects — the `catch`
             * is its outermost statement — because a timer callback has nobody to
             * hand a rejection to.
             */
            const regenerate = async (changedFile: string, onHookSettled: (consumedSources: string) => void): Promise<void> => {
                try {
                    // The server may have closed during the debounce window.
                    if (closed) {
                        return;
                    }

                    // Reuse the cached Project across runs: build it on first use,
                    // otherwise sync it with the on-disk file set so discovery sees
                    // the same files a fresh Project would — without re-parsing the
                    // whole TS program.
                    if (cachedProject === undefined) {
                        cachedProject = createCodegenProject(absoluteSchemaDirectory);
                    } else {
                        refreshCodegenProject(cachedProject, absoluteSchemaDirectory);
                    }

                    // `blockingMessage` (an ERROR-level advisory/platform
                    // diagnostic) is intentionally ignored here: dev stays
                    // log-only (already logged inside runCodegenSafely) —
                    // only `vite build`, in buildStart above, escalates it.
                    const { outputDirectory } = runCodegenSafely(options, serverLogger, overlay, cachedProject);

                    if (outputDirectory === undefined) {
                        // Codegen was skipped or threw — drop the (possibly partially
                        // mutated) cache so the next run rebuilds from scratch rather
                        // than risk emitting wrong code off a corrupted Project.
                        cachedProject = undefined;

                        return;
                    }

                    absoluteGeneratedDirectory = outputDirectory;

                    // Snapshot the sources codegen just consumed, so the settle
                    // recheck below can tell whether they moved under it while the
                    // project's `postcodegen` was running. Taken AFTER the emit —
                    // `runCodegen` only writes `_generated/`, so the sources are
                    // identical either way, and both this call and the recheck's
                    // then read the SAME `absoluteGeneratedDirectory` (the emit
                    // reassigns it one line above) and so exclude the same tree.
                    const consumedSources = fingerprintSchemaSources(absoluteSchemaDirectory);

                    // The project's post-generation step, before the client is told
                    // the API changed — the point of the hook is that what the dev
                    // server compiles is the FINISHED output, so reloading first
                    // would serve the unfinished copy for the hook's duration.
                    // Failures are reported inside the hook and never end the watch
                    // loop: the next edit is the chance to fix it.
                    // See the `buildStart` call for why the flag brackets the whole
                    // call rather than relying on the settle window alone.
                    hookRunning = true;

                    let hook;

                    try {
                        hook = await runPostCodegenHook({ cwd: options.projectRoot, logger: serverLogger });
                    } finally {
                        hookRunning = false;
                    }

                    // Armed only when a hook actually RAN — see HOOK_SETTLE_MS.
                    if (hook.ran) {
                        hookSettledAt = Date.now();
                        onHookSettled(consumedSources);
                    }

                    // Stop short of the reload when the post-step failed: the
                    // output on disk is exactly what the hook exists to finish, so
                    // pushing it to the client serves the unfinished copy. Leaving
                    // the previous modules in place keeps the app on the last
                    // version that WAS finished until the next save fixes it. The
                    // hook already reported why, and the watch loop stays alive.
                    if (hook.error !== undefined) {
                        return;
                    }

                    invalidateGenerated();

                    // Scope the reload: evict the workerd runner's module cache
                    // (invalidateModule alone doesn't reach it) and nudge the
                    // client with a custom event instead of a destructive browser
                    // reload — unless we're recovering from an error overlay.
                    notifyEnvironmentsAfterCodegen(server, changedFile, hadErrorOverlay);
                    hadErrorOverlay = false;
                } catch (error: unknown) {
                    // Awaiting the hook made this async, which turns what used to be
                    // an uncaught exception into a silent unhandled rejection.
                    serverLogger.error(`${LUNORA_TAG} codegen watch: ${error instanceof Error ? error.message : String(error)}`);
                }
            };

            // The watcher's timers and the budget that bounds them. It hands
            // `regenerate` the arming callback rather than being called back on,
            // so the two stay one-directional.
            const scheduler = createRegenerateScheduler({
                // Late-bound: `regenerate` reassigns `absoluteGeneratedDirectory`
                // from codegen's emit, and the recheck must exclude the same tree
                // the pre-hook snapshot did.
                fingerprint: () => fingerprintSchemaSources(absoluteSchemaDirectory),
                logger: serverLogger,
                regenerate: (changedFile: string, onHookSettled: (consumedSources: string) => void): void => {
                    // Fire-and-forget: `regenerate` reports every failure itself (its
                    // `catch` is its outermost statement) and there is nothing in a
                    // timer callback to await it from. Async at all because the
                    // project's `postcodegen` inside is a subprocess.
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- resolve-only by construction; a rejection here could only come from the catch handler itself
                    regenerate(changedFile, onHookSettled);
                },
            });

            const onChange = (file: string): void => {
                const normalized = resolve(file);

                // A tsconfig change can move path aliases / compiler options out
                // from under a reused Project, so drop the cache and rebuild it
                // from scratch on the next run. Checked FIRST — before the
                // schema-directory gate below — because the tsconfig that backs
                // cross-file type resolution (a shared validator, a path alias)
                // sits at the project root for every shipped template, not under
                // the schema directory; gating this on `absoluteSchemaDirectory`
                // first meant a root tsconfig save could never reach this branch.
                // `tsconfig.*.json` variants (e.g. a referenced
                // `tsconfig.build.json`) match by name wherever the watcher sees
                // them; it never triggers codegen itself — there is nothing new
                // to emit.
                if (TSCONFIG_VARIANT_RE.test(normalized)) {
                    cachedProject = undefined;

                    return;
                }

                // Only a file literally named `tsconfig.json` can possibly be the
                // one `findTsconfig` would resolve, so gate its (existsSync-walk)
                // cost on that cheap basename check instead of paying it on every
                // watcher event — every `.ts` save otherwise walked the tree just
                // to answer a question only a tsconfig save could ever say yes to.
                // Recomputed here rather than captured once, so a tsconfig created
                // AFTER the cached Project was first built — nothing was found
                // walking up from the schema directory that time, so the Project
                // fell back to an isolated one — still invalidates the moment it
                // appears on disk.
                if (normalized.endsWith(`${sep}tsconfig.json`) && normalized === findTsconfig(absoluteSchemaDirectory)) {
                    cachedProject = undefined;

                    return;
                }

                // Only react to changes inside the schema dir from here on, and
                // ignore generated output.
                if (!isInside(normalized, absoluteSchemaDirectory)) {
                    return;
                }

                if (isInside(normalized, absoluteGeneratedDirectory)) {
                    return;
                }

                if (!normalized.endsWith(".ts")) {
                    return;
                }

                // Skip test files — they aren't part of the schema/functions
                // surface and shouldn't trigger codegen.
                if (normalized.includes(`${sep}__tests__${sep}`) || normalized.endsWith(".test.ts") || normalized.endsWith(".spec.ts")) {
                    return;
                }

                // …and skip anything the project's `postcodegen` wrote, so a hook
                // that rewrites a schema-directory file doesn't read as a
                // developer's save: while it runs, and for a settle window after
                // it exits. See HOOK_SETTLE_MS.
                if (hookRunning || Date.now() - hookSettledAt < HOOK_SETTLE_MS) {
                    // Drop a debounce an earlier event already scheduled too —
                    // otherwise the hook's first write still lands a queued rerun.
                    scheduler.cancelPending();

                    return;
                }

                scheduler.onSave(normalized);
            };

            // A tsconfig DELETION can't be caught by the `normalized === findTsconfig(...)`
            // check inside `onChange` above: `findTsconfig` re-walks the tree at
            // call time, and by the time this fires the file is already gone, so
            // the live walk resolves to a DIFFERENT config (a parent's) or
            // `undefined` — never the deleted path, so that equality never
            // matches and a cached Project built against the now-missing
            // tsconfig would survive stale. Basename alone is enough here
            // (no `findTsconfig` re-walk needed): over-invalidating on an
            // unrelated tsconfig.json's removal costs a wasted rebuild, never
            // a wrong one — the same "degrade only toward extra work" contract
            // `readShapeMemoCursor`-style fallbacks in this repo already lean on.
            const onConfigFileRemoved = (file: string): void => {
                const normalized = resolve(file);

                if (normalized.endsWith(`${sep}tsconfig.json`) || TSCONFIG_VARIANT_RE.test(normalized)) {
                    cachedProject = undefined;
                }
            };

            // Gated at REGISTRATION, not inside the handler. Gating the run would
            // still pay for it: the debounced body builds or refreshes the whole
            // ts-morph program before calling codegen, and reads the skipped result
            // as "codegen threw" — dropping the cached Project, so the next save
            // rebuilds from scratch. Disabling codegen would cost more than leaving
            // it on, and log a line per keystroke. The tsconfig-invalidation handler
            // goes with it: it exists only to keep that cache honest.
            if (codegenDisabled) {
                server.config.logger.info(
                    `${LUNORA_TAG} codegen watch disabled (${CODEGEN_ENV}) — _generated/ is written only by an explicit \`lunora codegen\``,
                );
            } else {
                server.watcher.on("add", onChange);
                server.watcher.on("change", onChange);
                server.watcher.on("unlink", onChange);
                server.watcher.on("unlink", onConfigFileRemoved);
            }

            // The config files whose binding-relevant drift restarts the dev server
            // in place. Both wrangler candidate names are watched (even if absent
            // now) so creating one mid-session is caught. `@cloudflare/vite-plugin`
            // already restarts on its own wrangler config change when the Cloudflare
            // integration is active, but it does NOT watch lunora.json (the remote-
            // binding preference) — and Vite's `server.restart()` coalesces
            // concurrent calls via its `_restartPromise`, so a same-tick double
            // restart is harmless. Under the BYO (`cloudflare: false`) path nothing
            // else watches wrangler.jsonc, so this becomes the sole restart trigger.
            const configWatchPaths = new Set<string>([
                ...WRANGLER_FILES.map((name) => resolve(options.projectRoot, name)),
                resolve(options.projectRoot, LUNORA_CONFIG_FILE),
            ]);

            for (const configPath of configWatchPaths) {
                server.watcher.add(configPath);
            }

            const onConfigChange = (file: string): void => {
                if (!configWatchPaths.has(resolve(file))) {
                    return;
                }

                // A restart is already resolving — let it settle; the fresh server
                // reads the latest on-disk config, so this edit is not lost.
                if (restartInFlight) {
                    return;
                }

                const nextFingerprint = computeConfigFingerprint(options.projectRoot);

                // Startup window: buildStart may still be provisioning bindings into
                // wrangler.jsonc. Adopt those writes as the baseline rather than
                // treating them as external drift — restarting mid-boot is never what
                // the edit meant, and buildStart's re-baseline will settle the window.
                if (!configBaselineSettled) {
                    configFingerprint = nextFingerprint;

                    return;
                }

                // First observation (baseline not yet set) — adopt it, don't restart.
                if (configFingerprint === undefined) {
                    configFingerprint = nextFingerprint;

                    return;
                }

                // Unchanged binding-relevant slice — a codegen cron rewrite, or a
                // comment/whitespace-only edit. Nothing to restart for.
                if (nextFingerprint === configFingerprint) {
                    return;
                }

                // Adopt the new baseline BEFORE restarting so a failed restart (which
                // keeps the current server up) doesn't re-fire on the same edit.
                configFingerprint = nextFingerprint;
                restartInFlight = true;

                server.config.logger.info(`${LUNORA_TAG} ${basename(resolve(file))} changed — restarting dev server`);

                // `server.restart()` must never throw out of the watcher: on failure
                // keep serving the last-good config and surface the reason. The user
                // can re-save the config to retry. `.finally` clears the guard on both
                // paths; the terminal `.catch` handles a rejected restart (and marks
                // the promise handled, so it never floats).
                Promise.resolve(server.restart())
                    .finally(() => {
                        restartInFlight = false;
                    })
                    .catch((error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);

                        server.config.logger.error(
                            `${LUNORA_TAG} dev server restart failed: ${message} — keeping the running server; re-save your config to retry.`,
                        );
                        server.hot.send({ err: { loc: undefined, message: `[lunora] dev server restart failed: ${message}`, stack: "" }, type: "error" });
                    });
            };

            server.watcher.on("add", onConfigChange);
            server.watcher.on("change", onConfigChange);
            server.watcher.on("unlink", onConfigChange);

            // Tear down on server close: stop a pending debounce from firing on a
            // dead ws/module graph and drop the watcher listeners so repeated
            // `configureServer` invocations (restarts) don't leak handlers.
            // Idempotent (`closed` guard) since classic mode and the `buildEnd`
            // fallback below can both fire for the same server.
            const teardown = (): void => {
                if (closed) {
                    return;
                }

                closed = true;

                // Drop the reused Project so a restart rebuilds it fresh and the
                // parsed TS program isn't held past the server's life.
                cachedProject = undefined;

                scheduler.dispose();

                server.watcher.off("add", onChange);
                server.watcher.off("change", onChange);
                server.watcher.off("unlink", onChange);
                server.watcher.off("unlink", onConfigFileRemoved);
                server.watcher.off("add", onConfigChange);
                server.watcher.off("change", onConfigChange);
                server.watcher.off("unlink", onConfigChange);
            };

            return () => {
                registerDevServerClose(server, pendingMiddlewareTeardowns, teardown);
            };
        },
        buildEnd() {
            // Middleware-mode close fallback (no-op in classic dev mode and in
            // `vite build` — the map is only populated by a middleware-mode
            // `configureServer`); see `server-close.ts`.
            runPendingClose(pendingMiddlewareTeardowns, this.environment);
        },
        name: "lunora:codegen",
    };
};

export { codegenPlugin, reconcileBindingsSafely };
