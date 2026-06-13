import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { CodegenDiagnosticError, createCodegenProject, refreshCodegenProject, runCodegen } from "@cirrus/codegen";
import { inferCirrusBindings, reconcileWranglerBindings } from "@cirrus/config";
import type { Project } from "ts-morph";
import type { Plugin, ViteDevServer } from "vite";

import { reconcileWranglerCrons } from "./cron-sync";
import type { ResolvedCirrusPluginOptions } from "./types";

const DEBOUNCE_MS = 100;

/** Matches a project-variant tsconfig filename (`tsconfig.build.json`, …). */
const TSCONFIG_VARIANT_RE = /[/\\]tsconfig\..+\.json$/u;

/**
 * Infer the Cloudflare bindings the project's code implies and reconcile them
 * into `wrangler.jsonc` (Durable Objects, their migration classes, and the
 * `DB` D1 binding for `.global()` schemas). Best-effort and idempotent — runs
 * once at startup so the user never hand-writes binding boilerplate. A failure
 * here must never abort codegen; the wrangler validator reports real problems.
 */
const reconcileBindingsSafely = async (
    options: Pick<ResolvedCirrusPluginOptions, "projectRoot" | "schemaDir">,
    logger: { info?: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    try {
        const inferred = await inferCirrusBindings({ projectRoot: options.projectRoot, schemaDir: options.schemaDir });
        const reconciled = reconcileWranglerBindings(options.projectRoot, inferred);

        if (reconciled.changed) {
            logger.info?.(`[cirrus] inferred bindings → ${reconciled.added.join(", ")} (written to ${reconciled.wranglerPath ?? "wrangler.jsonc"})`);
        }

        for (const warning of reconciled.warnings) {
            logger.warn(`[cirrus] ${warning}`);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`[cirrus] binding inference skipped: ${message}`);
    }
};

/** Callbacks injected from the dev-server context into {@link runCodegenSafely}. */
interface OverlayCallbacks {
    /** Called on fatal codegen failure to push the error into the browser overlay. */
    onError: (error: unknown, message: string) => void;
    /** Called on success when the previous run failed, to clear the overlay. */
    onSuccess: () => void;
}

/**
 * Run codegen, returning the absolute directory codegen actually wrote to
 * (so callers can invalidate the *real* output, not an independently-guessed
 * path), or `undefined` when codegen was skipped or failed.
 *
 * Pass `overlay` to surface fatal failures in the Vite error overlay during
 * dev. Omit it (build mode) to keep the current log-and-return-undefined
 * behaviour.
 */
const runCodegenSafely = (
    options: Pick<ResolvedCirrusPluginOptions, "apiSpec" | "projectRoot" | "schemaDir">,
    logger: { error: (message: string) => void; info?: (message: string) => void; warn: (message: string) => void },
    overlay?: OverlayCallbacks,
    project?: Project,
): string | undefined => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`[cirrus] schema.ts not found at ${schemaPath} — codegen skipped`);

        return undefined;
    }

    try {
        const result = runCodegen({ apiSpec: options.apiSpec, cirrusDirectory: options.schemaDir, project, projectRoot: options.projectRoot });

        // Reconcile code-first cron definitions into wrangler.jsonc so the user
        // never hand-edits `triggers.crons`. Best-effort: a wrangler problem
        // must not abort codegen (the wrangler validator plugin reports those).
        try {
            const reconciled = reconcileWranglerCrons(options.projectRoot, result.cronTriggers);

            if (reconciled.changed) {
                logger.info?.(`[cirrus] synced ${result.cronTriggers.length.toFixed(0)} cron trigger(s) into ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
            }
        } catch (cronError: unknown) {
            const message = cronError instanceof Error ? cronError.message : String(cronError);

            logger.warn(`[cirrus] cron trigger sync skipped: ${message}`);
        }

        // Surface static schema advisories (unindexed FKs, …) in the dev/build
        // log. Codegen returns them without printing; the richer error-overlay
        // presentation is a later step.
        for (const advisory of result.advisories) {
            logger.warn(`[cirrus] schema advisory [${advisory.level}] ${advisory.name}: ${advisory.detail} — ${advisory.remediation}`);
        }

        // If the previous run failed, clear the browser error overlay now that
        // codegen succeeded and the generated files are up to date.
        overlay?.onSuccess();

        return resolve(result.outputDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`[cirrus] codegen failed: ${message}`);

        // In dev mode, surface the failure in the browser error overlay so the
        // user sees it immediately without leaving the browser.
        overlay?.onError(error, message);

        return undefined;
    }
};

/**
 * Vite plugin that runs `@cirrus/codegen` on startup and on file changes
 * inside the cirrus schema directory.
 */
const codegenPlugin = (options: ResolvedCirrusPluginOptions): Plugin => {
    const absoluteSchemaDirectory = resolve(options.projectRoot, options.schemaDir);

    // Seed from the resolved option, but treat codegen's returned output dir as
    // authoritative once it has run — codegen always writes to
    // `<schemaDir>/_generated` and ignores any custom `generatedDir`, so a
    // mismatching option would otherwise make the change-guard and the
    // invalidation loop below target the wrong (empty) directory.
    let absoluteGeneratedDirectory = resolve(options.projectRoot, options.generatedDir);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Captured in configureServer and used to push overlay events. Undefined in
    // build mode (vite build) — the overlay callbacks are never wired up then.
    let devServer: ViteDevServer | undefined;

    // Track whether the most recent codegen run failed so we can send a
    // full-reload (which clears the browser overlay) on the next success.
    let lastRunFailed = false;

    return {
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
            const outputDirectory = runCodegenSafely(options, logger);

            if (outputDirectory !== undefined) {
                absoluteGeneratedDirectory = outputDirectory;
            }

            // Auto-provision the bindings the code implies. Done once at startup
            // (not on every schema edit): bindings change rarely and a restart
            // picks up a newly-added capability.
            await reconcileBindingsSafely(options, logger);
        },
        configureServer(server: ViteDevServer) {
            devServer = server;

            server.watcher.add(absoluteSchemaDirectory);

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

            // Overlay callbacks: push failures to the browser and clear on recovery.
            const overlay: OverlayCallbacks = {
                onError(error, message) {
                    lastRunFailed = true;

                    const loc = error instanceof CodegenDiagnosticError ? { column: error.column, file: error.file, line: error.line } : undefined;

                    devServer?.hot.send({
                        err: {
                            loc,
                            message: `[cirrus] codegen failed: ${message}`,
                            stack: error instanceof Error ? (error.stack ?? "") : "",
                        },
                        type: "error",
                    });
                },
                onSuccess() {
                    if (lastRunFailed) {
                        lastRunFailed = false;
                        devServer?.hot.send({ type: "full-reload" });
                    }
                },
            };

            // True only for the directory itself or a real descendant — a bare
            // `startsWith` would also match a sibling whose name shares the
            // prefix (e.g. `cirrus-foo/` for schemaDir `cirrus`).
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

            // Invalidate generated modules across every module graph so the dev
            // server picks up new types/values. Vite 6's environment API (used by
            // `@cloudflare/vite-plugin` for the worker/SSR environment) keeps
            // per-environment graphs that the legacy `server.moduleGraph` doesn't
            // cover, so walk those too when present.
            type ModuleGraphLike = {
                idToModuleMap: Map<string, { id: string | null }>;
                invalidateModule: (module: { id: string | null }) => void;
            };

            const invalidateGenerated = (): void => {
                // `environments` is absent on Vite < 6 / partial mocks; the cast
                // through `unknown` keeps the runtime guard meaningful.
                const environments = server.environments as unknown as Record<string, { moduleGraph?: ModuleGraphLike }> | undefined;
                const graphs: ModuleGraphLike[] = [];

                if (environments !== undefined) {
                    for (const environment of Object.values(environments)) {
                        if (environment.moduleGraph !== undefined) {
                            graphs.push(environment.moduleGraph);
                        }
                    }
                }

                if (graphs.length === 0) {
                    graphs.push(server.moduleGraph as unknown as ModuleGraphLike);
                }

                for (const graph of graphs) {
                    for (const moduleEntry of graph.idToModuleMap.values()) {
                        if (moduleEntry.id && isInside(moduleEntry.id, absoluteGeneratedDirectory)) {
                            // Invalidate via the owning graph so per-environment
                            // graphs are handled correctly.
                            graph.invalidateModule(moduleEntry);
                        }
                    }
                }
            };

            const onChange = (file: string): void => {
                // Only react to changes inside the schema dir, and ignore generated output.
                const normalized = resolve(file);

                if (!isInside(normalized, absoluteSchemaDirectory)) {
                    return;
                }

                if (isInside(normalized, absoluteGeneratedDirectory)) {
                    return;
                }

                // A tsconfig change can move path aliases / compiler options out
                // from under a reused Project, so drop the cache and rebuild it
                // from scratch on the next run. Checked before the `.ts` gate so
                // a `tsconfig*.json` save still invalidates (it never triggers
                // codegen itself — there is nothing new to emit).
                if (normalized.endsWith(`${sep}tsconfig.json`) || TSCONFIG_VARIANT_RE.test(normalized)) {
                    cachedProject = undefined;

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

                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }

                debounceTimer = setTimeout(() => {
                    debounceTimer = undefined;

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

                    const outputDirectory = runCodegenSafely(options, serverLogger, overlay, cachedProject);

                    if (outputDirectory === undefined) {
                        // Codegen was skipped or threw — drop the (possibly partially
                        // mutated) cache so the next run rebuilds from scratch rather
                        // than risk emitting wrong code off a corrupted Project.
                        cachedProject = undefined;

                        return;
                    }

                    absoluteGeneratedDirectory = outputDirectory;

                    invalidateGenerated();

                    server.ws.send({ type: "full-reload" });
                }, DEBOUNCE_MS);
            };

            server.watcher.on("add", onChange);
            server.watcher.on("change", onChange);
            server.watcher.on("unlink", onChange);

            // Tear down on server close: stop a pending debounce from firing on a
            // dead ws/module graph and drop the watcher listeners so repeated
            // `configureServer` invocations (restarts) don't leak handlers.
            return () => {
                server.httpServer?.once("close", () => {
                    closed = true;

                    // Drop the reused Project so a restart rebuilds it fresh and the
                    // parsed TS program isn't held past the server's life.
                    cachedProject = undefined;

                    if (debounceTimer) {
                        clearTimeout(debounceTimer);
                        debounceTimer = undefined;
                    }

                    server.watcher.off("add", onChange);
                    server.watcher.off("change", onChange);
                    server.watcher.off("unlink", onChange);
                });
            };
        },
        name: "cirrus:codegen",
    };
};

export default codegenPlugin;
