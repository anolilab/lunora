/**
 * Guards against the agent docs losing track of a package.
 *
 * `AGENTS.md` (which `CLAUDE.md` symlinks to) is what every coding agent reads,
 * and it points at `.agents/docs/packages.md` to decide which package owns a
 * change. That `## Packages` table is
 * hand-maintained, so a new or extracted package only appears there if whoever
 * added it remembered — and five in a row did not: `@lunora/auth-ui`,
 * `@lunora/platform`, `@lunora/platform-cloudflare`, `@lunora/platform-node`,
 * and `@lunora/shard-engine` all shipped without a row. An agent asked to touch
 * auth UI found no `auth-ui` package, and either edited `@lunora/auth` or
 * invented a location. Wrong-package edits and duplicated code are the failure
 * mode, and nothing else in the repo catches it.
 *
 * The check is deliberately loose: it asserts only that each `packages/*`
 * manifest name appears *somewhere* across `AGENTS.md` + `.agents/docs/*.md`.
 * A prose mention counts, in either file. That
 * keeps it from being brittle about table formatting (Prettier reflows the
 * column widths on every edit) while still failing on the case that actually
 * hurts — a package the docs have never heard of.
 *
 * Scope is `packages/` only. `apps/`, `examples/`, `templates/`, and `tests/`
 * are described by the repo-layout prose rather than enumerated, so requiring a
 * per-directory mention there would fail on the docs' own design.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");
const agentDocsDir = join(rootDir, ".agents", "docs");

let agentsMd;

try {
    agentsMd = readFileSync(join(rootDir, "AGENTS.md"), "utf8");
} catch {
    console.error("❌ AGENTS.md is missing or unreadable at the repo root.");
    console.error("   It is the entry point for every coding agent — restore it before continuing.");

    process.exit(1);
}

try {
    for (const entry of readdirSync(agentDocsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
            agentsMd += readFileSync(join(agentDocsDir, entry.name), "utf8");
        }
    }
} catch {
    console.error("❌ .agents/docs/ is missing or unreadable.");
    console.error("   AGENTS.md defers the package map to it — restore it before continuing.");

    process.exit(1);
}

const missing = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }

    let manifest;

    try {
        manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));
    } catch {
        continue;
    }

    // A word-boundary match, not `includes`: `@lunora/platform` is a prefix of
    // `@lunora/platform-node` and `@lunora/platform-cloudflare`, so a plain
    // substring test let the shorter row satisfy every longer name — three
    // packages could go undocumented while this printed a tick.
    if (
        typeof manifest.name !== "string" ||
        new RegExp(String.raw`${manifest.name.replaceAll(/[$()*+.?[\^{|]/gu, String.raw`\$&`)}(?![\w/-])`, "u").test(agentsMd)
    ) {
        continue;
    }

    missing.push({ directory: entry.name, name: manifest.name });
}

if (missing.length > 0) {
    console.error(`❌ ${missing.length} package(s) exist on disk but are never mentioned in the agent docs:`);

    for (const { directory, name } of missing) {
        console.error(`   ${name} (packages/${directory})`);
    }

    console.error("   Add a row to the `## Packages` table in .agents/docs/packages.md describing what the package owns.");
    console.error("   Agents use that table to pick which package a change belongs in.");

    process.exit(1);
}

console.log("✅ Every packages/* manifest name appears in AGENTS.md or .agents/docs/.");
