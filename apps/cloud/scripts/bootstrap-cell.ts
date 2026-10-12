/* eslint-disable no-console -- a terminal tool: the per-resource report it prints is the deliverable. */
/*
 * Brings one cell's Cloudflare resources and GitHub Environment secrets to the
 * state its deploy needs, and says what it could not do.
 *
 * ```bash
 * node --experimental-strip-types scripts/bootstrap-cell.ts staging [--dry-run]
 * ```
 *
 * Everything is read from `env.<cell>` in `wrangler.jsonc`, so a resource name
 * cannot drift from what the deploy binds. Each resource is handled on its own:
 * a missing one is created, an existing one is left alone, and a step the account
 * cannot take yet (a plan feature, an interactive command) is reported and the
 * run carries on.
 *
 * Secrets follow one rule: a GitHub Environment secret that already exists is
 * never replaced. A regenerated `SECRET_ENCRYPTION_KEY` or `AUTH_SECRET` makes
 * stored tenant secrets and sessions unreadable, so the script only creates the
 * names that are missing and never prints a value.
 *
 * It finishes with `check-deploy-config.ts`, the same gate the deploy runs.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

const environment = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (environment !== "staging" && environment !== "production") {
    console.error("usage: bootstrap-cell.ts staging|production [--dry-run]");
    process.exitCode = 2;
    throw new Error(`unknown environment: ${environment}`);
}

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The GitHub Environment the deploy workflow reads this cell's secrets from. */
const githubEnvironment = `cloud-${environment}`;

interface Run {
    code: number;
    stderr: string;
    stdout: string;
}

const run = (command: string, args: ReadonlyArray<string>, input?: string): Run => {
    const result = spawnSync(command, args, { cwd: appDirectory, encoding: "utf8", input });

    return { code: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
};

const wrangler = (args: ReadonlyArray<string>): Run => run("pnpm", ["exec", "wrangler", ...args]);

/** Cloudflare error codes the account answers with when a feature is not on its plan. */
const PLAN_BLOCKED_CODES = ["code: 1021", "code: 10121"];
/** The R2 error for a bucket that does not exist. */
const BUCKET_MISSING_CODE = "code: 10006";

const isPlanBlocked = (output: string): boolean => PLAN_BLOCKED_CODES.some((code) => output.includes(code));

const firstLine = (output: string): string =>
    output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "") ?? "failed";

// --- config -----------------------------------------------------------------

interface CellConfig {
    d1_databases?: { database_id?: string; database_name?: string }[];
    dispatch_namespaces?: { namespace?: string }[];
    pipelines?: { stream?: string }[];
    r2_buckets?: { bucket_name?: string }[];
}

const wranglerConfig = parseJsonc(readFileSync(resolve(appDirectory, "wrangler.jsonc"), "utf8")) as { env?: Record<string, CellConfig> } | undefined;
const cell = wranglerConfig?.env?.[environment];

if (cell === undefined) {
    console.error(`wrangler.jsonc has no env.${environment} block.`);
    process.exitCode = 1;
    throw new Error(`no env.${environment} block`);
}

const say = (line: string): void => {
    console.log(line);
};

// --- Cloudflare resources ---------------------------------------------------

const bootstrapD1 = (): void => {
    for (const database of cell.d1_databases ?? []) {
        const name = database.database_name;

        if (name === undefined) {
            say(`  d1: a binding has no database_name — nothing to check`);
            continue;
        }

        const list = wrangler(["d1", "list", "--json"]);

        if (list.code !== 0) {
            say(`  d1 ${name}: blocked — ${firstLine(list.stderr)}`);
            continue;
        }

        const existing = (JSON.parse(list.stdout) as { name: string; uuid: string }[]).find((entry) => entry.name === name);

        if (existing !== undefined) {
            say(`  d1 ${name}: exists (${existing.uuid})`);
            continue;
        }

        if (dryRun) {
            say(`  d1 ${name}: would create`);
            continue;
        }

        const created = wrangler(["d1", "create", name]);

        say(
            created.code === 0
                ? `  d1 ${name}: created — paste its id into env.${environment}.d1_databases`
                : `  d1 ${name}: blocked — ${firstLine(created.stderr)}`,
        );
    }
};

const bootstrapR2 = (): void => {
    for (const bucket of cell.r2_buckets ?? []) {
        const name = bucket.bucket_name;

        if (name === undefined) {
            continue;
        }

        const info = wrangler(["r2", "bucket", "info", name]);

        if (info.code === 0) {
            say(`  r2 ${name}: exists`);
            continue;
        }

        if (!`${info.stdout}${info.stderr}`.includes(BUCKET_MISSING_CODE)) {
            say(`  r2 ${name}: blocked — ${firstLine(info.stderr)}`);
            continue;
        }

        if (dryRun) {
            say(`  r2 ${name}: would create`);
            continue;
        }

        const created = wrangler(["r2", "bucket", "create", name]);

        say(created.code === 0 ? `  r2 ${name}: created` : `  r2 ${name}: blocked — ${firstLine(created.stderr)}`);
    }
};

const bootstrapDispatchNamespaces = (): void => {
    for (const entry of cell.dispatch_namespaces ?? []) {
        const name = entry.namespace;

        if (name === undefined) {
            continue;
        }

        const get = wrangler(["dispatch-namespace", "get", name]);
        const output = `${get.stdout}${get.stderr}`;

        if (get.code === 0) {
            say(`  dispatch namespace ${name}: exists`);
            continue;
        }

        if (isPlanBlocked(output)) {
            say(`  dispatch namespace ${name}: blocked — Workers for Platforms is not on this account (buy it in the dashboard, then rerun)`);
            continue;
        }

        if (dryRun) {
            say(`  dispatch namespace ${name}: would create`);
            continue;
        }

        const created = wrangler(["dispatch-namespace", "create", name]);

        say(created.code === 0 ? `  dispatch namespace ${name}: created` : `  dispatch namespace ${name}: blocked — ${firstLine(created.stderr)}`);
    }
};

const bootstrapPipelines = (): void => {
    for (const pipeline of cell.pipelines ?? []) {
        const { stream } = pipeline;

        if (stream === undefined) {
            continue;
        }

        const list = wrangler(["pipelines", "list"]);

        if (isPlanBlocked(`${list.stdout}${list.stderr}`)) {
            say(`  pipeline ${stream}: blocked — Workers Paid is required for pipelines`);
            continue;
        }

        // `pipelines setup` is interactive and has no non-interactive form here, so
        // a missing pipeline is named, not created.
        say(
            list.code === 0 && list.stdout.includes(stream)
                ? `  pipeline ${stream}: exists`
                : `  pipeline ${stream}: create by hand with \`pnpm exec wrangler pipelines setup\`, then check its stream name`,
        );
    }
};

// --- GitHub Environment secrets --------------------------------------------

const REPO = (() => {
    const result = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);

    return result.code === 0 ? result.stdout.trim() : "anolilab/lunora";
})();

/** Generated here, never typed. Each is set once and then kept. */
const GENERATED_SECRETS = [
    "AUTH_SECRET",
    "SECRET_ENCRYPTION_KEY",
    "LUNORA_ADMIN_TOKEN",
    "LUNORA_TAIL_SECRET",
    "LUNORA_LINEAGE_SECRET",
    "CLOUD_GITHUB_WEBHOOK_SECRET",
    "CLOUD_GITHUB_SETUP_STATE_SECRET",
];

/** Provider values this script cannot make; reported when missing. */
const PROVIDED_SECRETS = [
    "CLOUDFLARE_API_TOKEN",
    "CELL_CLOUDFLARE_API_TOKEN",
    "CREEM_API_KEY",
    "CREEM_WEBHOOK_SECRET",
    "CLOUD_GITHUB_APP_ID",
    "CLOUD_GITHUB_APP_PRIVATE_KEY",
    "CLOUD_GITHUB_APP_SLUG",
];

const existingSecretNames = (): Set<string> => {
    const result = run("gh", ["secret", "list", "--env", githubEnvironment, "--repo", REPO, "--json", "name", "--jq", ".[].name"]);

    if (result.code !== 0) {
        throw new Error(`gh secret list --env ${githubEnvironment} failed: ${firstLine(result.stderr)}`);
    }

    return new Set(result.stdout.split("\n").filter((line) => line !== ""));
};

const bootstrapSecrets = (): void => {
    const present = existingSecretNames();

    for (const name of GENERATED_SECRETS) {
        if (present.has(name)) {
            say(`  secret ${name}: kept (already set)`);
            continue;
        }

        if (dryRun) {
            say(`  secret ${name}: would generate`);
            continue;
        }

        // The value goes through stdin, never argv, and is not echoed.
        const set = run("gh", ["secret", "set", name, "--env", githubEnvironment, "--repo", REPO], randomBytes(32).toString("hex"));

        say(set.code === 0 ? `  secret ${name}: generated and set` : `  secret ${name}: failed — ${firstLine(set.stderr)}`);
    }

    for (const name of PROVIDED_SECRETS) {
        if (!present.has(name)) {
            say(`  secret ${name}: missing — set it with \`gh secret set ${name} --env ${githubEnvironment}\``);
        }
    }
};

// --- run --------------------------------------------------------------------

console.log(`bootstrap ${environment}${dryRun ? " (dry run)" : ""} — ${REPO}\n`);

console.log("Cloudflare resources:");
bootstrapD1();
bootstrapR2();
bootstrapDispatchNamespaces();
bootstrapPipelines();

console.log("\nGitHub Environment secrets:");
bootstrapSecrets();

console.log("\nDeploy gate:");
const gate = run(process.execPath, ["--experimental-strip-types", "scripts/check-deploy-config.ts", environment]);

console.log(gate.code === 0 ? `  ${environment}: deploy config has no placeholders.` : `  ${environment}: still refused —\n${gate.stderr || gate.stdout}`);
process.exitCode = gate.code;
