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
 * NOT wired into `postinstall` yet: one pre-existing violation ("stripe",
 * hand-pinned differently in `packages/payment` and `examples/payment-demo`)
 * means it does not pass clean — see plan 327 §9. Run it manually
 * (`node scripts/check-catalog-drift.js`) and wire it into `postinstall` once
 * that's resolved.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dirname, "..");

const WORKSPACE_GLOBS = ["apps", "packages", "examples", "tests"];

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

const manifests = [];

for (const group of WORKSPACE_GLOBS) {
    const groupDir = join(rootDir, group);
    let entries;

    try {
        entries = readdirSync(groupDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
        continue;
    }

    for (const entry of entries) {
        try {
            const manifest = JSON.parse(readFileSync(join(groupDir, entry.name, "package.json"), "utf8"));

            manifests.push({ dir: `${group}/${entry.name}`, manifest });
        } catch {
            continue;
        }
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

            (bySpecifier.get(specifier) ?? bySpecifier.set(specifier, []).get(specifier)).push(dir);
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

    console.error(`❌ "${name}" is hand-pinned (not catalog:) in ${dirs.length} manifests: ${dirs.join(", ")}`);
}

if (violations > 0) {
    console.error(`❌ ${violations} dependency name(s) drifted outside a catalog across 2+ manifests.`);
    process.exit(1);
}

console.log("✅ No dependency is hand-pinned outside a catalog in more than one manifest.");
