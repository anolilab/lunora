/* eslint-disable no-console -- a terminal gate: the list of unresolved ids it prints is the deliverable, not a stray debug statement. */
/*
 * Pre-deploy gate for the three cloud wrangler configs.
 *
 * Every deployed environment in `wrangler.jsonc`, `dispatcher.wrangler.jsonc`
 * and `tail.wrangler.jsonc` ships with `<replace-with-…>` placeholders where a
 * per-cell resource id or URL belongs — a D1 uuid, the control-plane hostname,
 * the account id. Wrangler happily publishes a Worker bound to a D1 database
 * that does not exist: the deploy is green and the first query at runtime is
 * the failure, in production, with no line back to the config that caused it.
 *
 * So the placeholders are checked before anything is published. This runs as
 * its own step in `.github/workflows/deploy-cloud.yml`, and by hand before a
 * first deploy:
 *
 * ```bash
 * node --experimental-strip-types scripts/check-deploy-config.ts production
 * ```
 *
 * Only the SELECTED environment is inspected. The top-level config is the
 * local-dev target and keeps its placeholders on purpose, so scanning the whole
 * file would refuse every deploy forever.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

/** The three deployables, in the order the workflow publishes them. */
const CONFIGS = ["wrangler.jsonc", "dispatcher.wrangler.jsonc", "tail.wrangler.jsonc"] as const;

/** The marker every unfilled value carries — the `replace-with-…` placeholder convention the configs and `.dev.vars.example` share. */
const PLACEHOLDER = /<replace-with-[^>]*>/u;

/** Every `path -> value` leaf under `node`, so a placeholder can be reported where it actually lives. */
const leaves = function* (node: unknown, path: string): Generator<[string, string]> {
    if (typeof node === "string") {
        yield [path, node];

        return;
    }

    if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
            yield* leaves(item, `${path}[${String(index)}]`);
        }

        return;
    }

    if (typeof node === "object" && node !== null) {
        for (const [key, value] of Object.entries(node)) {
            yield* leaves(value, path === "" ? key : `${path}.${key}`);
        }
    }
};

const environment = process.argv[2];

if (environment !== "staging" && environment !== "production") {
    console.error("usage: check-deploy-config.ts staging|production");
    process.exitCode = 2;
    throw new Error(`unknown environment: ${environment}`);
}

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings: string[] = [];

for (const config of CONFIGS) {
    const file = resolve(appDirectory, config);
    const parsed = parseJsonc(readFileSync(file, "utf8")) as { env?: Record<string, unknown> } | undefined;
    const block = parsed?.env?.[environment];

    if (block === undefined) {
        findings.push(`${config}: no "env.${environment}" block — the deploy would silently publish the local-dev target instead`);

        continue;
    }

    for (const [path, value] of leaves(block, "")) {
        if (PLACEHOLDER.test(value)) {
            findings.push(`${config}: env.${environment}.${path} is still ${value}`);
        }
    }
}

if (findings.length > 0) {
    console.error(`Refusing to deploy "${environment}" — ${String(findings.length)} unresolved placeholder(s):\n`);

    for (const finding of findings) {
        console.error(`  • ${finding}`);
    }

    console.error(
        [
            "",
            "Create the resources once per cell and paste the ids in:",
            "  wrangler d1 create lunora-cloud[-staging]",
            "  wrangler r2 bucket create lunora-cloud-telemetry[-staging]",
            "  wrangler queues create lunora-tenant-queue[-staging]",
            "  wrangler pipelines create lunora-cloud-telemetry[-staging]",
            "",
            "The control-plane URLs are this cell's own reachable origin (the workers.dev",
            "URL of `lunora-cloud[-staging]`, or its custom hostname once a zone is attached).",
        ].join("\n"),
    );

    process.exitCode = 1;
} else {
    console.log(`${environment}: all three wrangler configs resolved, no placeholders left.`);
}
