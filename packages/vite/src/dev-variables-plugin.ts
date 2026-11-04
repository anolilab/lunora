import { resolve } from "node:path";

import {
    checkDevEnv,
    createConfirm,
    describeDevEnvCheck,
    ensureDevVariables,
    ensureDevWorkerEnv,
    fillDevSecrets,
    inferLunoraBindings,
    lunoraLine,
    secretSourcesFromBindings,
} from "@lunora/config";
import type { Plugin, ViteDevServer } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * The project's secret sources, read with the schema directory the plugin was given. When its bindings cannot be read, every dev
 * secret is generated as before the sources were passed, so a broken tsconfig or barrel does not stop dev startup.
 */
const secretSourcesOrUndefined = async (
    projectRoot: string,
    schemaDirectory: string,
    info: (message: string) => void,
): Promise<ReadonlyArray<string> | undefined> => {
    try {
        return secretSourcesFromBindings(await inferLunoraBindings({ projectRoot, schemaDir: schemaDirectory }));
    } catch (error) {
        info(`could not read the project's bindings, so every dev secret is generated: ${error instanceof Error ? error.message : String(error)}`);

        return undefined;
    }
};

/**
 * Run the project's `defineEnv` contract against the dev env and log what it
 * found. Answers whether the env failed the contract, so an edit that fixes it
 * can say so.
 */
const reportDevEnv = async (
    options: ResolvedLunoraPluginOptions,
    log: { info: (message: string) => void; warn: (message: string) => void },
    wasInvalid: boolean,
): Promise<boolean> => {
    const check = await checkDevEnv({ projectRoot: options.projectRoot, schemaDirectory: options.schemaDir });
    const report = describeDevEnvCheck(check, options.schemaDir);

    if (report !== undefined) {
        log[report.level](lunoraLine(report.message));
    } else if (wasInvalid && check.kind === "valid") {
        log.info(lunoraLine(`${options.schemaDir}/env.ts: the dev env satisfies the contract again`));
    }

    return check.kind === "invalid";
};

/**
 * Dev-only Vite plugin that prepares `.dev.vars` before the worker boots.
 * `@cloudflare/vite-plugin` loads `.dev.vars` into the worker's `env`, but the
 * file is gitignored — so a fresh clone has none and the worker throws on the
 * first required secret (e.g. `AUTH_SECRET is required`). All three steps live in
 * `@lunora/config`, shared with `lunora dev` and `@lunora/rspack`.
 *
 * First, {@link ensureDevVariables}: when a `.dev.vars.example` exists, prompt
 * to generate `.dev.vars` from it with secrets auto-filled. Second,
 * {@link fillDevSecrets}: fill any empty/placeholder secret already in
 * `.dev.vars` that Lunora can mint locally (a `lunora add`-scaffolded project
 * writes secrets blank) and ensure `LUNORA_ADMIN_TOKEN` is present + generated —
 * so the worker boots with working secrets and the Studio authenticates without
 * its login gate. No prompt: it only generates locally-derivable values and
 * never overwrites a real one. Third, {@link ensureDevWorkerEnv}.
 *
 * Runs in `configResolved` (awaited by Vite) so it completes before the
 * Cloudflare plugin reads the file. Non-interactive runs decline silently.
 *
 * Last, it checks the env against the project's `defineEnv` contract and warns
 * about missing or invalid keys, which `defineEnv` would otherwise report only
 * as a 500 from the first request that reads one. A `.dev.vars`, `.env` or
 * wrangler.jsonc edit restarts the dev server (`@cloudflare/vite-plugin` and the
 * codegen plugin do that), which re-runs this hook; an `env.ts` edit does not,
 * so the plugin watches that file itself.
 * Skipped under `vite preview`, which resolves with `command: "serve"` and so
 * runs `apply: "serve"` plugins too — previewing a built app must not prompt to
 * scaffold, or write, a dev secrets file.
 */
const devVariablesPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let isPreview = false;
    let envInvalid = false;

    return {
        apply: "serve",
        // `isPreview` is on the config-hook env only — never on the resolved config.
        config(_userConfig, env) {
            isPreview = env.isPreview === true;
        },
        async configResolved() {
            if (isPreview) {
                return;
            }

            const info = (message: string): void => {
                // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                console.info(lunoraLine(message));
            };

            await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info });

            const secretSources = await secretSourcesOrUndefined(options.projectRoot, options.schemaDir, info);
            fillDevSecrets({ cwd: options.projectRoot, info, secretSources });
            ensureDevWorkerEnv(options.projectRoot, info);

            // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
            envInvalid = await reportDevEnv(options, { info: console.info, warn: console.warn }, envInvalid);
        },
        configureServer(server: ViteDevServer) {
            if (isPreview) {
                return;
            }

            const envPath = resolve(options.projectRoot, options.schemaDir, "env.ts");
            const log = {
                info: (message: string): void => {
                    server.config.logger.info(message);
                },
                warn: (message: string): void => {
                    server.config.logger.warn(message);
                },
            };

            const recheck = async (): Promise<void> => {
                envInvalid = await reportDevEnv(options, log, envInvalid);
            };

            // The watcher closes with the server, and a restart builds a new one, so the listeners need no teardown.
            const onChange = (file: string): void => {
                if (resolve(file) === envPath) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- resolve-only by construction: `checkDevEnv` never rejects
                    recheck();
                }
            };

            server.watcher.add(envPath);
            server.watcher.on("add", onChange);
            server.watcher.on("change", onChange);
        },
        enforce: "pre",
        name: "lunora:dev-vars",
    };
};

export default devVariablesPlugin;
