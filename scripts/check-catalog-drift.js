/**
 * Guards against a dependency drifting into two or more workspace manifests
 * with hand-typed, non-`catalog:` version specifiers.
 *
 * A pnpm catalog exists so one version of a shared dependency is pinned once
 * and referenced everywhere (`CLAUDE.md`'s "Dependency Catalog" rule). When a
 * second manifest picks up the same package with its own literal specifier
 * instead of `catalog:<name>`, the two copies silently diverge on the next
 * bump to either one — the Angular toolchain (`@angular/core` `^22.0.8` in
 * `packages/angular` vs `^22.0.7` in `packages/auth-ui`) and the duplicated
 * `cron-parser` / `better-sqlite3` runtime deps (plan 327) are exactly this
 * failure mode, caught only by a one-off audit.
 *
 * `@lunora/*` / `lunorash` sibling packages are excluded: this repo pins
 * those exact-version-per-package deliberately (see
 * `scripts/check-sibling-peer-ranges.js`'s doc comment) so
 * multi-semantic-release can bump each consumer in lockstep with its
 * dependency's release — that is a different, already-guarded mechanism, not
 * catalog drift.
 *
 * Run by the `dependency-manifests` job in `.github/workflows/lint.yml`, and by
 * hand as `pnpm run lint:catalog-drift`. (The header used to say it was unwired
 * because of a pre-existing "stripe" violation; both the violation and the
 * wiring gap are gone.)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { workspaceGroups } from "./workspace-config.js";

const rootDir = join(import.meta.dirname, "..");

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

const manifests = [];

// From `pnpm-workspace.yaml`, not a hardcoded list: a new workspace glob was
// otherwise never walked, and the `catch { continue }` below meant a group that
// could not be read looked exactly like a group with nothing in it.
for (const group of workspaceGroups()) {
    const groupDir = join(rootDir, group);
    let entries;

    try {
        entries = readdirSync(groupDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (error) {
        console.error(`❌ pnpm-workspace.yaml declares "${group}/*" but ${group}/ could not be read: ${error.message}`);
        process.exit(1);
    }

    let found = 0;

    for (const entry of entries) {
        try {
            const manifest = JSON.parse(readFileSync(join(groupDir, entry.name, "package.json"), "utf8"));

            manifests.push({ dir: `${group}/${entry.name}`, manifest });
            found += 1;
        } catch {
            continue;
        }
    }

    // A declared workspace glob with no readable member is a broken checkout or a
    // stale glob, not a clean bill of health.
    if (found === 0) {
        console.error(`❌ pnpm-workspace.yaml declares "${group}/*" but no ${group}/*/package.json could be read — nothing was checked for that group.`);
        process.exit(1);
    }
}

/** name -> Map<specifier, dir[]>, excluding catalog: and workspace: specifiers. */
const seen = new Map();

for (const { dir, manifest } of manifests) {
    for (const section of ["dependencies", "devDependencies"]) {
        for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
            if (isSibling(name) || typeof specifier !== "string" || specifier.startsWith("catalog:") || specifier.startsWith("workspace:")) {
                continue;
            }

            const bySpecifier = seen.get(name) ?? new Map();

            if (!bySpecifier.has(specifier)) {
                bySpecifier.set(specifier, []);
            }

            bySpecifier.get(specifier).push(dir);
            seen.set(name, bySpecifier);
        }
    }
}

let violations = 0;

for (const [name, bySpecifier] of seen) {
    const dirs = [...bySpecifier.values()].flat();

    if (dirs.length < 2) {
        continue;
    }

    violations += 1;

    const bySpecifierDetail = [...bySpecifier.entries()].map(([specifier, specifierDirs]) => `${specifier} (${specifierDirs.join(", ")})`).join("; ");

    console.error(`❌ "${name}" is hand-pinned (not catalog:) in ${dirs.length} manifests: ${bySpecifierDetail}`);
}

if (violations > 0) {
    console.error(`❌ ${violations} dependency name(s) drifted outside a catalog across 2+ manifests.`);
    process.exit(1);
}

console.log(`✅ No dependency is hand-pinned outside a catalog in more than one manifest (${manifests.length} manifests read).`);
