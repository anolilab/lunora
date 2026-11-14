import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { DevEnvCheck, DevEnvCheckOptions } from "@lunora/config";
import {
    checkDevEnv,
    createConfirm,
    describeDevEnvCheck,
    detectFramework,
    ensureDevVariables,
    ensureDevWorkerEnv,
    ENV_FILENAME,
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
 * The dev sidecar config the SvelteKit / Nuxt worker runs (`wrangler dev -c
 * wrangler.dev.jsonc --var WORKER_ENV:development`); it, not the deploy config,
 * holds what that worker reads.
 */
const DEV_SIDECAR_CONFIG = "wrangler.dev.jsonc";

/** The frameworks whose worker `lunora dev` runs in that sidecar, beside the framework's own dev server. */
const SIDECAR_FRAMEWORKS = new Set(["nuxt", "sveltekit"]);

/**
 * What the env contract is checked against: the config the dev worker runs. That
 * is the sidecar's only on a framework that runs one — a `wrangler.dev.jsonc`
 * left in any other project is not what its worker boots with.
 */
const devEnvCheckOptions = (options: ResolvedLunoraPluginOptions, worker: { configPath?: string; withheld: ReadonlyArray<string> }): DevEnvCheckOptions => {
    const sidecar = resolve(options.projectRoot, DEV_SIDECAR_CONFIG);
    const base = { projectRoot: options.projectRoot, schemaDirectory: options.schemaDir };

    if (SIDECAR_FRAMEWORKS.has(detectFramework(options.projectRoot).framework) && existsSync(sidecar)) {
        // The sidecar runs its committed config as is: no temp copy, so nothing withheld.
        return { ...base, configPath: sidecar, vars: { WORKER_ENV: "development" } };
    }

    return { ...base, configPath: worker.configPath, withheld: worker.withheld };
};

/**
 * Whether each project's env last failed its contract. Module scope because a
 * `.dev.vars`, `.env` or wrangler config edit restarts Vite, which runs the
 * config again and builds a new plugin; the restart's check needs the answer
 * the old one had to say the fix took.
 */
const lastEnvInvalid = new Map<string, boolean>();

/**
 * Log what a check found through `log`, and answer whether the env is still
 * known to fail the contract, which the next run passes back so an edit that
 * fixes it says so. A contract that could not be loaded says nothing about the
 * env, so the previous answer stands.
 */
const reportDevEnv = (check: DevEnvCheck, schemaDirectory: string, log: Record<"info" | "warn", (message: string) => void>, wasInvalid: boolean): boolean => {
    const report = describeDevEnvCheck(check, schemaDirectory, { wasInvalid });

    if (report !== undefined) {
        log[report.level](lunoraLine(report.message));
    }

    return check.kind === "invalid" || (check.kind === "unloadable" && wasInvalid);
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
 * so the plugin watches that file itself. `configPath` is the wrangler config
 * the Cloudflare plugin runs, when it is not the project's own; `withheld` names
 * the bindings the remote-bindings plugin left out of this session, which the
 * check must not treat as present.
 * Skipped under `vite preview`, which resolves with `command: "serve"` and so
 * runs `apply: "serve"` plugins too — previewing a built app must not prompt to
 * scaffold, or write, a dev secrets file.
 */
const devVariablesPlugin = (
    options: ResolvedLunoraPluginOptions,
    { configPath, withheld = () => [] }: { configPath?: string; withheld?: () => ReadonlyArray<string> } = {},
): Plugin => {
    let isPreview = false;
    let envInvalid = lastEnvInvalid.get(options.projectRoot) ?? false;
    // Bumped per check, so a check an `env.ts` save overtook neither logs nor sets `envInvalid`.
    let generation = 0;

    const runCheck = async (log: Record<"info" | "warn", (message: string) => void>): Promise<void> => {
        generation += 1;

        const started = generation;
        const check = await checkDevEnv(devEnvCheckOptions(options, { configPath, withheld: withheld() }));

        if (started === generation) {
            envInvalid = reportDevEnv(check, options.schemaDir, log, envInvalid);
            lastEnvInvalid.set(options.projectRoot, envInvalid);
        }
    };

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

            const warn = (message: string): void => {
                // eslint-disable-next-line no-console -- dev-server startup notice, before Vite's logger is wired up
                console.warn(lunoraLine(message));
            };

            const scaffold = await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info, warn });

            // An unreadable dev-vars file was reported as "nothing written"; writing `.dev.vars` now would contradict it.
            if (scaffold.status !== "unreadable") {
                const secretSources = await secretSourcesOrUndefined(options.projectRoot, options.schemaDir, info);
                fillDevSecrets({ cwd: options.projectRoot, info, secretSources });
                ensureDevWorkerEnv(options.projectRoot, info);
            }

            // `console`: a startup notice, before Vite's logger is wired up.
            await runCheck(console);
        },
        configureServer(server: ViteDevServer) {
            if (isPreview) {
                return;
            }

            const envPath = resolve(options.projectRoot, options.schemaDir, ENV_FILENAME);

            // The watcher closes with the server, and a restart builds a new one, so the listeners need no teardown.
            const onChange = (file: string): void => {
                if (resolve(file) === envPath) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- resolve-only by construction: `checkDevEnv` never rejects
                    runCheck(server.config.logger);
                }
            };

            server.watcher.add(envPath);
            server.watcher.on("add", onChange);
            server.watcher.on("change", onChange);
            // A deleted contract checks as absent, which retracts a warning it left.
            server.watcher.on("unlink", onChange);
        },
        enforce: "pre",
        name: "lunora:dev-vars",
    };
};

export default devVariablesPlugin;
