import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    createConfirm,
    DEV_VARS_FILE,
    ensureDevVariables,
    fillDevSecrets,
    parseDevVariableEntries,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import { lunoraLine } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Worker env var the dev tooling sets so the Lunora runtime recognises a
 * development deployment (`@lunora/do`'s `isDevEnvironment`) and therefore
 * streams every RPC dispatch summary to the terminal, keeps argument/error
 * detail unredacted, and runs the studio security audit with `dev: true`.
 * `lunora dev` sets the same var via `wrangler dev --var`.
 */
const DEV_WORKER_ENV_VAR = "WORKER_ENV";
const DEV_WORKER_ENV_VALUE = "development";

/** The `vars` block of whichever wrangler config the project has, or `{}` (none, or unparseable). */
const wranglerVariables = (projectRoot: string): Record<string, unknown> => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        return {};
    }

    return readWranglerJsonc<WranglerConfig>(wranglerPath).parsed?.vars ?? {};
};

/**
 * Declare the dev worker's environment in `.dev.vars` when nothing else does.
 *
 * `.dev.vars` is the one channel that reaches the dev worker's `env` on EVERY
 * host: `@cloudflare/vite-plugin` and `wrangler dev` both load it, whether the
 * Cloudflare plugin is the one `lunora()` adds or the one the project adds
 * itself (`cloudflare: false` — the shipped vinext default). Setting it through
 * the plugin's own options reached only the first of those, so the BYO path ran
 * its whole dev session with `isDevEnvironment` false.
 *
 * The file is gitignored and dev-only, so this can never reach a deployed
 * worker. A `WORKER_ENV` the developer already declares — in `.dev.vars` or in
 * the wrangler config's `vars` — wins and is never overwritten.
 */
const ensureDevWorkerEnv = (projectRoot: string, info: (message: string) => void): void => {
    const path = join(projectRoot, DEV_VARS_FILE);
    let content: string;

    try {
        content = readFileSync(path, "utf8");
    } catch {
        // No `.dev.vars` (a project with no secrets at all): `fillDevSecrets`
        // creates one whenever there is anything to write, so nothing to top up.
        return;
    }

    if (parseDevVariableEntries(content).some((entry) => entry.key === DEV_WORKER_ENV_VAR) || DEV_WORKER_ENV_VAR in wranglerVariables(projectRoot)) {
        return;
    }

    // The same atomic, owner-only write every other `.dev.vars` writer uses — a
    // torn write here would take the developer's secrets with it.
    writeDevVariablesFileAtomically(path, upsertDevVariableLine(content, DEV_WORKER_ENV_VAR, DEV_WORKER_ENV_VALUE));

    info(`set ${DEV_WORKER_ENV_VAR}=${DEV_WORKER_ENV_VALUE} in ${DEV_VARS_FILE} so the dev worker runs in development mode`);
};

/**
 * Dev-only Vite plugin that prepares `.dev.vars` before the worker boots.
 * `@cloudflare/vite-plugin` loads `.dev.vars` into the worker's `env`, but the
 * file is gitignored — so a fresh clone has none and the worker throws on the
 * first required secret (e.g. `AUTH_SECRET is required`). Three steps, the first
 * two shared with `lunora dev` via `@lunora/config`.
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
 * Skipped under `vite preview`, which resolves with `command: "serve"` and so
 * runs `apply: "serve"` plugins too — previewing a built app must not prompt to
 * scaffold, or write, a dev secrets file.
 */
const devVariablesPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let isPreview = false;

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

            fillDevSecrets({ cwd: options.projectRoot, info });
            ensureDevWorkerEnv(options.projectRoot, info);
        },
        enforce: "pre",
        name: "lunora:dev-vars",
    };
};

export { DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, devVariablesPlugin };
