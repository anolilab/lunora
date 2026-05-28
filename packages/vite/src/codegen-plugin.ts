import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { runCodegen } from "@cirrus/codegen";
import type { Plugin, ViteDevServer } from "vite";

import type { ResolvedCirrusPluginOptions } from "./types.js";

const DEBOUNCE_MS = 100;

const runCodegenSafely = (
    options: Pick<ResolvedCirrusPluginOptions, "projectRoot" | "schemaDir">,
    logger: { error: (message: string) => void; warn: (message: string) => void },
): boolean => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`[cirrus] schema.ts not found at ${schemaPath} — codegen skipped`);

        return false;
    }

    try {
        runCodegen({ cirrusDirectory: options.schemaDir, projectRoot: options.projectRoot });

        return true;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`[cirrus] codegen failed: ${message}`);

        return false;
    }
};

/**
 * Vite plugin that runs `@cirrus/codegen` on startup and on file changes
 * inside the cirrus schema directory.
 */
export const codegenPlugin = (options: ResolvedCirrusPluginOptions): Plugin => {
    const absoluteSchemaDirectory = resolve(options.projectRoot, options.schemaDir);
    const absoluteGeneratedDirectory = resolve(options.projectRoot, options.generatedDir);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    return {
        name: "cirrus:codegen",
        buildStart() {
            const logger = {
                error: (message: string): void => {
                    // eslint-disable-next-line no-console
                    console.error(message);
                },
                warn: (message: string): void => {
                    // eslint-disable-next-line no-console
                    console.warn(message);
                },
            };

            runCodegenSafely(options, logger);
        },
        configureServer(server: ViteDevServer) {
            server.watcher.add(absoluteSchemaDirectory);

            const onChange = (file: string): void => {
                // Only react to changes inside the schema dir, and ignore generated output.
                const normalized = resolve(file);

                if (!normalized.startsWith(absoluteSchemaDirectory)) {
                    return;
                }

                if (normalized.startsWith(absoluteGeneratedDirectory)) {
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
                    const ok = runCodegenSafely(options, {
                        error: (message: string) => {
                            server.config.logger.error(message);
                        },
                        warn: (message: string) => {
                            server.config.logger.warn(message);
                        },
                    });

                    if (ok) {
                        // Invalidate generated modules so the dev server picks up new types/values.
                        for (const moduleEntry of server.moduleGraph.idToModuleMap.values()) {
                            if (moduleEntry.id && moduleEntry.id.startsWith(absoluteGeneratedDirectory)) {
                                server.moduleGraph.invalidateModule(moduleEntry);
                            }
                        }

                        server.ws.send({ type: "full-reload" });
                    }
                }, DEBOUNCE_MS);
            };

            server.watcher.on("add", onChange);
            server.watcher.on("change", onChange);
            server.watcher.on("unlink", onChange);
        },
    };
};
