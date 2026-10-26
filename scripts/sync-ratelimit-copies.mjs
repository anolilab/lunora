#!/usr/bin/env node
/**
 * Generate every vendored `lunora/ratelimit/schema.ts` in `templates/*` and
 * `examples/*` from the `ratelimit` registry item, the source of truth.
 *
 * The copies cannot come from `lunora add ratelimit`: examples are workspaces that
 * are never scaffolded, and templates already wire `.extend(ratelimit.extension)`
 * by hand. Left hand-maintained, they drifted (a missing `by_ts` index, other
 * imports). The one part that is legitimately per-app is the `limits` block —
 * each app enforces its own named limits — so that block (with the doc comment
 * directly above it) is kept from the existing copy and everything else is the
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

    if (lines[start - 1]?.trim() === "*/") {
        while (!lines[start - 1].trimStart().startsWith("/**")) {
            start -= 1;
        }

        start -= 1;
    }

    return [start, end + 1];
};

const itemPath = join(ROOT, "registry", "ratelimit", "schema.ts");
const itemLines = readFileSync(itemPath, "utf8").replaceAll('from "@lunora/', 'from "lunorash/').split("\n");
const [itemStart, itemEnd] = limitsBlock(itemLines, itemPath);

const copies = ["templates", "examples"].flatMap((group) =>
    readdirSync(join(ROOT, group))
        .map((app) => join(ROOT, group, app, "lunora", "ratelimit", "schema.ts"))
        .filter((file) => existsSync(file)),
);

const stale = [];

for (const copy of copies) {
    const current = readFileSync(copy, "utf8");
    const lines = current.split("\n");
    const [start, end] = limitsBlock(lines, copy);
    const next = [...itemLines.slice(0, itemStart), ...lines.slice(start, end), ...itemLines.slice(itemEnd)].join("\n");

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
