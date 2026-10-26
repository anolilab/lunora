#!/usr/bin/env node
/**
 * Generate every vendored `lunora/ratelimit/schema.ts` in `templates/*` and
 * `examples/*` from the `ratelimit` registry item, the source of truth.
 *
 * The copies cannot come from `lunora add ratelimit`: examples are workspaces that
 * are never scaffolded, and templates already wire `.extend(ratelimit.extension)`
 * by hand. Left hand-maintained, they drifted (a missing `by_ts` index, other
 * imports). Two parts are legitimately per-app and are kept from the existing
 * copy: the leading file doc comment (the item's describes `lunora add`, which
 * never wrote these files) and the `limits` block with the doc comment directly
 * above it (each app enforces its own named limits). Everything else is the
 * item's, with `@lunora/*` imports spelled `lunorash/*`.
 *
 * Usage:
 *   node scripts/sync-ratelimit-copies.mjs           # rewrite the copies
 *   node scripts/sync-ratelimit-copies.mjs --check   # CI drift guard: fail if stale
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/** `[start, end)` line range of the `limits` export plus the doc comment directly above it. */
const limitsBlock = (lines, file) => {
    const declaration = lines.findIndex((line) => line.startsWith("export const limits = {"));
    const end = lines.findIndex((line, index) => index > declaration && line.startsWith("} as const satisfies RateLimitConfigMap;"));

    if (declaration === -1 || end === -1) {
        throw new Error(`${relative(ROOT, file)}: no \`export const limits = { … } as const satisfies RateLimitConfigMap;\` block`);
    }

    let start = declaration;
    const above = lines[start - 1]?.trim() ?? "";

    if (above.startsWith("/**") && above.endsWith("*/")) {
        start -= 1;
    } else if (above === "*/") {
        while (!lines[start - 1].trimStart().startsWith("/**")) {
            start -= 1;
        }

        start -= 1;
    }

    return [start, end + 1];
};

/** `[0, end)` line range of the file's leading doc comment. */
const headerBlock = (lines, file) => {
    const end = lines.findIndex((line) => line.trim() === "*/");

    if (lines[0] !== "/**" || end === -1) {
        throw new Error(`${relative(ROOT, file)}: no leading /** … */ file doc comment`);
    }

    return [0, end + 1];
};

const itemPath = join(ROOT, "registry", "ratelimit", "schema.ts");
const itemLines = readFileSync(itemPath, "utf8").replaceAll('from "@lunora/', 'from "lunorash/').split("\n");
const [, itemHeaderEnd] = headerBlock(itemLines, itemPath);
const [itemStart, itemEnd] = limitsBlock(itemLines, itemPath);

// An app needs a copy when its schema imports one, so a deleted copy is reported rather than skipped.
const apps = ["templates", "examples"].flatMap((group) => readdirSync(join(ROOT, group)).map((app) => join(ROOT, group, app, "lunora")));
const needsCopy = (app) => existsSync(join(app, "schema.ts")) && readFileSync(join(app, "schema.ts"), "utf8").includes("./ratelimit/schema");
const copies = apps.filter((app) => existsSync(join(app, "ratelimit", "schema.ts"))).map((app) => join(app, "ratelimit", "schema.ts"));
const missing = apps.filter((app) => needsCopy(app) && !existsSync(join(app, "ratelimit", "schema.ts")));

// Not regenerated: the header and limits that make a copy app-specific exist nowhere else.
if (missing.length > 0) {
    process.stderr.write(
        `these apps import ./ratelimit/schema but have no copy — restore it from git, then re-run:\n${missing.map((app) => `  ${relative(ROOT, join(app, "ratelimit", "schema.ts"))}`).join("\n")}\n`,
    );
    process.exit(1);
}

const stale = [];

for (const copy of copies) {
    const current = readFileSync(copy, "utf8");
    const lines = current.split("\n");
    const [, headerEnd] = headerBlock(lines, copy);
    const [start, end] = limitsBlock(lines, copy);
    const next = [...lines.slice(0, headerEnd), ...itemLines.slice(itemHeaderEnd, itemStart), ...lines.slice(start, end), ...itemLines.slice(itemEnd)].join(
        "\n",
    );

    if (next === current) {
        continue;
    }

    stale.push(relative(ROOT, copy));

    if (!CHECK) {
        writeFileSync(copy, next);
    }
}

if (CHECK && stale.length > 0) {
    process.stderr.write(
        `these lunora/ratelimit/schema.ts copies differ from registry/ratelimit/schema.ts — run \`node scripts/sync-ratelimit-copies.mjs\`:\n${stale.map((path) => `  ${path}`).join("\n")}\n`,
    );
    process.exit(1);
}

process.stdout.write(
    CHECK ? `ratelimit copies are up to date (${copies.length}).\n` : `Synced ratelimit copies (${stale.length} of ${copies.length} changed).\n`,
);
