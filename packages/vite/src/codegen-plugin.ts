import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { runCodegen } from "@cirrus/codegen";
import { inferCirrusBindings, reconcileWranglerBindings } from "@cirrus/config";
import type { Plugin, ViteDevServer } from "vite";

import { reconcileWranglerCrons } from "./cron-sync";
import type { ResolvedCirrusPluginOptions } from "./types";

const DEBOUNCE_MS = 100;

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

/**
 * Run codegen, returning the absolute directory codegen actually wrote to
 * (so callers can invalidate the *real* output, not an independently-guessed
 * path), or `undefined` when codegen was skipped or failed.
 */
const runCodegenSafely = (
    options: Pick<ResolvedCirrusPluginOptions, "projectRoot" | "schemaDir">,
    logger: { error: (message: string) => void; info?: (message: string) => void; warn: (message: string) => void },
): string | undefined => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`[cirrus] schema.ts not found at ${schemaPath} — codegen skipped`);

        return undefined;
    }

    try {
        const result = runCodegen({ cirrusDirectory: options.schemaDir, projectRoot: options.projectRoot });

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

        return resolve(result.outputDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`[cirrus] codegen failed: ${message}`);

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

            // True only for the directory itself or a real descendant — a bare
            // `startsWith` would also match a sibling whose name shares the
            // prefix (e.g. `cirrus-foo/` for schemaDir `cirrus`).
            const isInside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory + sep);

            // Set once the server is torn down so a debounced callback that fires
            // after `close` no-ops instead of writing to a dead ws/module graph.
            let closed = false;

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

                    const outputDirectory = runCodegenSafely(options, serverLogger);

                    if (outputDirectory !== undefined) {
                        absoluteGeneratedDirectory = outputDirectory;

                        invalidateGenerated();

                        server.ws.send({ type: "full-reload" });
                    }
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
