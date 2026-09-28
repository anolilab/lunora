/**
 * Declare the dev worker's environment in `.dev.vars` when nothing else does.
 *
 * `.dev.vars` is the one channel that reaches the dev worker's `env` on EVERY
 * host: `@cloudflare/vite-plugin` and `wrangler dev` both load it. Setting it
 * through a bundler plugin's own options reaches only the first of those, so a
 * BYO-worker project — the shipped vinext default, and every `@lunora/rspack`
 * project by construction — ran its whole dev session with `isDevEnvironment`
 * false: no RPC dispatch summaries, redacted argument/error detail, and the
 * studio security audit running as if in production.
 *
 * `lunora dev` sets the same var via `wrangler dev --var`, so it is covered
 * either way; a developer running plain `wrangler dev` alongside their bundler is
 * the case this exists for.
 *
 * The file is gitignored and dev-only, so this can never reach a deployed worker.
 * A `WORKER_ENV` the developer already declares — in `.dev.vars` or in the
 * wrangler config's `vars` — wins and is never overwritten.
 */
import { readFileSync } from "node:fs";

// The concrete modules, not the `./cloudflare` barrel: that barrel pulls in
// `assert-wrangler`, which imports `./log-badge` from this same package — a cycle
// the bundler resolves to an undefined binding at runtime rather than an error.
import { findWranglerFile, readWranglerJsonc } from "./cloudflare/wrangler-path";
import type { WranglerConfig } from "./cloudflare/wrangler-validator";
import { DEV_VARS_FILE, parseDevVariableEntries, upsertDevVariableLine } from "./dev-variables-format";
import join from "./path";
import { writeDevVariablesFileAtomically } from "./scaffold-dev-variables";

/**
 * Worker env var the dev tooling sets so the Lunora runtime recognises a
 * development deployment (`@lunora/do`'s `isDevEnvironment`) and therefore
 * streams every RPC dispatch summary to the terminal, keeps argument/error
 * detail unredacted, and runs the studio security audit with `dev: true`.
 */
const DEV_WORKER_ENV_VAR = "WORKER_ENV";

/** The value that flags a dev deployment. */
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
 * Top up `.dev.vars` with the dev-environment flag unless the project already
 * declares it (in `.dev.vars` itself, or in the wrangler config's `vars`).
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

export { DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, ensureDevWorkerEnv };
