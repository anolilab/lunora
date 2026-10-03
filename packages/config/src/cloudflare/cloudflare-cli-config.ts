/**
 * Guard against a Cloudflare CLI (`cf`) config next to Lunora's wrangler config.
 *
 * `cf migrate` writes a typed `cloudflare.config.ts` beside `wrangler.jsonc`, and
 * `cf dev` / `cf build` / `cf deploy` read that file instead. Lunora owns the
 * wrangler config — codegen and `lunora deploy` reconcile bindings, Durable
 * Object classes and migrations, workflows and containers into it — and never
 * touches `cloudflare.config.ts`, so a `cf` lifecycle command would deploy from a
 * config that silently misses everything Lunora adds after the migration.
 *
 * `cf` *resource* commands (zones, DNS, KV, …) next to a Wrangler project are
 * fine. Until Lunora supports `cf` (https://github.com/anolilab/lunora/issues/964),
 * every surface — `lunora doctor`, `lunora deploy`, codegen, the dev server and
 * the bundler plugins — reports the file through the two helpers here, so the
 * wording lives in one place.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

import join from "../path";
import { claimOncePerProcessTree, isClaimedInProcessTree } from "../process-tree-once";
import { findWranglerFile } from "./wrangler-path";

/** Candidate Cloudflare CLI config filenames, probed in the project root (the directory holding the wrangler config). */
const CLOUDFLARE_CLI_CONFIG_FILES = ["cloudflare.config.ts", "cloudflare.config.mts", "cloudflare.config.js", "cloudflare.config.mjs"] as const;

/** The tracking issue for first-class `cf` support. */
const CLOUDFLARE_CLI_ISSUE_URL = "https://github.com/anolilab/lunora/issues/964";

/** Env var the once-per-process-tree guard behind {@link warnCloudflareCliConfigOnce} sets. */
const CLOUDFLARE_CLI_CONFIG_WARNING_ENV = "LUNORA_CF_CONFIG_WARNING_SHOWN";

/** A detected Cloudflare CLI config: what was found, and what to do about it. */
interface CloudflareCliConfigFinding {
    /** What to do — `cf` resource commands are fine, lifecycle commands are not. Links the tracking issue. */
    fix: string;
    /** One line: which file was found, where, and why it is a problem. */
    message: string;
}

/**
 * Detect a Cloudflare CLI config (`cloudflare.config.{ts,mts,js,mjs}`) in
 * `projectRoot`, or `undefined` when there is none. The message names the
 * wrangler config actually present (`wrangler.jsonc` / `wrangler.json`), or says
 * "in the project root" when there is none yet.
 */
const detectCloudflareCliConfig = (projectRoot: string): CloudflareCliConfigFinding | undefined => {
    const fileName = CLOUDFLARE_CLI_CONFIG_FILES.find((candidate) => existsSync(join(projectRoot, candidate)));

    if (fileName === undefined) {
        return undefined;
    }

    const wranglerPath = findWranglerFile(projectRoot);
    const wranglerName = wranglerPath === undefined ? undefined : basename(wranglerPath);
    const where = wranglerName === undefined ? "in the project root" : `next to ${wranglerName}`;

    return {
        fix:
            "`cf` resource commands (zones, DNS, KV, …) are fine. Don't use `cf dev` / `cf build` / `cf deploy` on a Lunora project " +
            `until Lunora supports \`cf\` — see ${CLOUDFLARE_CLI_ISSUE_URL}.`,
        message:
            `${fileName} found ${where}. Lunora manages ${wranglerName ?? "the wrangler config"} and never updates a Cloudflare CLI (\`cf\`) config, ` +
            "so `cf dev` / `cf build` / `cf deploy` would run from a stale config, silently missing the bindings, Durable Object classes and migrations Lunora adds.",
    };
};

/**
 * Warn through `warn` when `projectRoot` holds a Cloudflare CLI config — once
 * per process tree (a rebuild, a dev-server restart, or a child process that
 * inherited the env stays quiet). The guard is read before the filesystem probe,
 * and claimed only when there is something to say. Non-blocking by design: the
 * risk is a separate `cf` lifecycle command, not anything Lunora runs. Returns
 * whether it warned.
 */
const warnCloudflareCliConfigOnce = (projectRoot: string, warn: (message: string) => void): boolean => {
    if (isClaimedInProcessTree(CLOUDFLARE_CLI_CONFIG_WARNING_ENV)) {
        return false;
    }

    const finding = detectCloudflareCliConfig(projectRoot);

    if (finding === undefined || !claimOncePerProcessTree(CLOUDFLARE_CLI_CONFIG_WARNING_ENV)) {
        return false;
    }

    warn(`${finding.message} ${finding.fix}`);

    return true;
};

export type { CloudflareCliConfigFinding };
export { CLOUDFLARE_CLI_CONFIG_WARNING_ENV, detectCloudflareCliConfig, warnCloudflareCliConfigOnce };
