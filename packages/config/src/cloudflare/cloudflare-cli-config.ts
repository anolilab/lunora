/**
 * Guard against a Cloudflare CLI (`cf`) config next to Lunora's `wrangler.jsonc`.
 *
 * `cf migrate` writes a typed `cloudflare.config.ts` beside `wrangler.jsonc`, and
 * `cf dev` / `cf build` / `cf deploy` read that file instead. Lunora owns
 * `wrangler.jsonc` — codegen and `lunora deploy` reconcile bindings, Durable
 * Object classes and migrations, workflows and containers into it — and never
 * touches `cloudflare.config.ts`, so a `cf` lifecycle command would deploy from a
 * config that silently misses everything Lunora adds after the migration.
 *
 * `cf` *resource* commands (zones, DNS, KV, …) next to a Wrangler project are
 * fine. Until Lunora supports `cf` (https://github.com/anolilab/lunora/issues/964),
 * every surface — `lunora doctor`, `lunora deploy`, codegen and the dev server —
 * reports the file through the helpers here, so the wording lives in one place.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

import join from "../path";

/** Candidate Cloudflare CLI config filenames, probed in the project root (the directory holding `wrangler.jsonc`). */
const CLOUDFLARE_CLI_CONFIG_FILES = ["cloudflare.config.ts", "cloudflare.config.mts", "cloudflare.config.js", "cloudflare.config.mjs"] as const;

/** The tracking issue for first-class `cf` support. */
const CLOUDFLARE_CLI_ISSUE_URL = "https://github.com/anolilab/lunora/issues/964";

/** Env var the once-per-process-tree warning guard ({@link claimCloudflareCliConfigWarning}) sets. */
const CLOUDFLARE_CLI_CONFIG_WARNING_ENV = "LUNORA_CF_CONFIG_WARNING_SHOWN";

/** Locate a Cloudflare CLI config in `projectRoot`, or `undefined` when there is none. */
const findCloudflareCliConfig = (projectRoot: string): string | undefined => {
    for (const candidate of CLOUDFLARE_CLI_CONFIG_FILES) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

/** The one-line summary: what was found (by file name) and why it is a problem. */
const describeCloudflareCliConfig = (configPath: string): string =>
    `${basename(configPath)} found next to wrangler.jsonc. Lunora manages wrangler.jsonc and never updates a Cloudflare CLI (\`cf\`) config, ` +
    "so `cf dev` / `cf build` / `cf deploy` would run from a stale config, silently missing the bindings, Durable Object classes and migrations Lunora adds.";

/** What to do about it — shared by the doctor `fix` line and the one-time warning. */
const CLOUDFLARE_CLI_CONFIG_ADVICE: string =
    "`cf` resource commands (zones, DNS, KV, …) are fine. Don't use `cf dev` / `cf build` / `cf deploy` on a Lunora project " +
    `until Lunora supports \`cf\` — see ${CLOUDFLARE_CLI_ISSUE_URL}.`;

/**
 * Process-tree guard so the warning is emitted at most once. The first surface
 * to print it sets {@link CLOUDFLARE_CLI_CONFIG_WARNING_ENV} on `process.env`;
 * later ones (a rebuild, a dev-server restart, or a child process that inherited
 * the env, like the Vite server `lunora dev` spawns) stay quiet. Returns `true`
 * the first time, `false` afterwards.
 */
const claimCloudflareCliConfigWarning = (): boolean => {
    if (process.env[CLOUDFLARE_CLI_CONFIG_WARNING_ENV] === "1") {
        return false;
    }

    process.env[CLOUDFLARE_CLI_CONFIG_WARNING_ENV] = "1";

    return true;
};

/**
 * Warn through `warn` when `projectRoot` holds a Cloudflare CLI config — once
 * per process tree. Non-blocking by design: Lunora itself deploys with Wrangler,
 * which ignores the file, so the risk is a separate `cf` lifecycle command.
 * Returns whether it warned.
 */
const warnCloudflareCliConfigOnce = (projectRoot: string, warn: (message: string) => void): boolean => {
    const configPath = findCloudflareCliConfig(projectRoot);

    if (configPath === undefined || !claimCloudflareCliConfigWarning()) {
        return false;
    }

    warn(`${describeCloudflareCliConfig(configPath)} ${CLOUDFLARE_CLI_CONFIG_ADVICE}`);

    return true;
};

export {
    claimCloudflareCliConfigWarning,
    CLOUDFLARE_CLI_CONFIG_ADVICE,
    CLOUDFLARE_CLI_CONFIG_FILES,
    CLOUDFLARE_CLI_CONFIG_WARNING_ENV,
    CLOUDFLARE_CLI_ISSUE_URL,
    describeCloudflareCliConfig,
    findCloudflareCliConfig,
    warnCloudflareCliConfigOnce,
};
