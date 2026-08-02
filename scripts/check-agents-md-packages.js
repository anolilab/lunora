/**
 * Guards against `AGENTS.md` losing track of a package.
 *
 * `AGENTS.md` (which `CLAUDE.md` symlinks to) is what every coding agent reads
 * to decide which package owns a change. Its `### Packages` table is
 * hand-maintained, so a new or extracted package only appears there if whoever
 * added it remembered — and five in a row did not: `@lunora/auth-ui`,
 * `@lunora/platform`, `@lunora/platform-cloudflare`, `@lunora/platform-node`,
 * and `@lunora/shard-engine` all shipped without a row. An agent asked to touch
 * auth UI found no `auth-ui` package, and either edited `@lunora/auth` or
 * invented a location. Wrong-package edits and duplicated code are the failure
 * mode, and nothing else in the repo catches it.
 *
 * The check is deliberately loose: it asserts only that each `packages/*`
 * manifest name appears *somewhere* in the file. A prose mention counts. That
 * keeps it from being brittle about table formatting (Prettier reflows the
 * column widths on every edit) while still failing on the case that actually
 * hurts — a package the file has never heard of.
 *
 * Scope is `packages/` only. `apps/`, `examples/`, `templates/`, and `tests/`
 * are described by the repo-layout table rather than enumerated, so requiring a
 * per-directory mention there would fail on the file's own design.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");
const agentsMdPath = join(rootDir, "AGENTS.md");

let agentsMd;

try {
    agentsMd = readFileSync(agentsMdPath, "utf8");
} catch {
    console.error("❌ AGENTS.md is missing or unreadable at the repo root.");
    console.error("   It is the entry point for every coding agent — restore it before continuing.");

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

    if (typeof manifest.name !== "string" || agentsMd.includes(manifest.name)) {
        continue;
    }

    missing.push({ directory: entry.name, name: manifest.name });
}

if (missing.length > 0) {
    console.error(`❌ ${missing.length} package(s) exist on disk but are never mentioned in AGENTS.md:`);

    for (const { directory, name } of missing) {
        console.error(`   ${name} (packages/${directory})`);
    }

    console.error("   Add a row to the `### Packages` table describing what the package owns.");
    console.error("   Agents use that table to pick which package a change belongs in.");

    process.exit(1);
}

console.log("✅ Every packages/* manifest name appears in AGENTS.md.");
