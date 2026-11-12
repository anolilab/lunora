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
 * `@lunora/*` / `lunorash` sibling packages are excluded: their specifiers are
 * owned by the release (see `scripts/check-sibling-peer-ranges.js`'s doc
 * comment), which rewrites each consumer in lockstep with its dependency's
 * release — that is a different, already-guarded mechanism, not catalog
 * drift.
 *
 * The same run also compares the catalogs with each other. A name that sits in
 * two catalogs with different specifiers means a bump to one catalog (`vis
 * update`) silently leaves the other behind, which the manifest check cannot
 * see. Deliberate splits are listed in `CATALOG_ALLOWLIST` with their reason;
 * a listed split that has since been aligned is reported too, so the list
 * cannot quietly go stale.
 *
 * Run by the `dependency-manifests` job in `.github/workflows/lint.yml`, and by
 * hand as `pnpm run lint:catalog-drift`. (The header used to say it was unwired
 * because of a pre-existing "stripe" violation; both the violation and the
 * wiring gap are gone.)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogs, workspaceGroups } from "./workspace-config.js";

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
}

/** Each split here is deliberate. An entry is only valid while its specifiers differ. */
const CATALOG_ALLOWLIST = new Map([
    [
        "solid-js",
        "solid2 catalog tracks the Solid 2 RC on purpose: it moves independently of frontend's Solid 1 (see the solid2 comment in pnpm-workspace.yaml)",
    ],
    [
        "vite-plugin-solid",
        "solid2 catalog tracks the Solid 2 RC on purpose: it moves independently of frontend's Solid 1 (see the solid2 comment in pnpm-workspace.yaml)",
    ],
    [
        "@solidjs/testing-library",
        "solid2 catalog tracks the Solid 2 RC on purpose: it moves independently of frontend's Solid 1 (see the solid2 comment in pnpm-workspace.yaml)",
    ],
    [
        "jiti",
        "tooling (^2.7.0) and cli (2.7.0) both ship in published dependencies (@lunora/codegen, @lunora/config vs @lunora/cli); aligning either changes a published range, so it is the owner's call",
    ],
    [
        "@tanstack/react-router",
        "web pins match @tanstack/start-static-server-functions@1.167.39, which depends on start-client-core 1.170.34 / router-core 1.171.34; moving them to frontend's versions gives apps/docs two router-core copies. Align together with a start-static-server-functions bump",
    ],
    [
        "@tanstack/react-start",
        "web pins match @tanstack/start-static-server-functions@1.167.39, which depends on start-client-core 1.170.34 / router-core 1.171.34; moving them to frontend's versions gives apps/docs two router-core copies. Align together with a start-static-server-functions bump",
    ],
]);

/** name -> [catalog, specifier][] across every named catalog. */
const byCatalogName = new Map();

for (const [catalogName, entries] of Object.entries(catalogs())) {
    for (const [name, specifier] of Object.entries(entries)) {
        byCatalogName.set(name, [...(byCatalogName.get(name) ?? []), [catalogName, specifier]]);
    }
}

let catalogViolations = 0;

for (const [name, entries] of byCatalogName) {
    const distinct = new Set(entries.map(([, specifier]) => specifier));

    if (distinct.size < 2 || CATALOG_ALLOWLIST.has(name)) {
        continue;
    }

    catalogViolations += 1;

    const detail = entries.map(([catalogName, specifier]) => `${catalogName}=${specifier}`).join(", ");

    console.error(`❌ "${name}" has different specifiers across catalogs: ${detail}`);
}

for (const name of CATALOG_ALLOWLIST.keys()) {
    const entries = byCatalogName.get(name) ?? [];
    const distinct = new Set(entries.map(([, specifier]) => specifier));

    if (entries.length >= 2 && distinct.size >= 2) {
        continue;
    }

    catalogViolations += 1;

    console.error(`❌ "${name}" is on the cross-catalog allowlist but no longer differs — remove it`);
}

if (violations > 0 || catalogViolations > 0) {
    process.exit(1);
}

console.log(`✅ No dependency is hand-pinned outside a catalog in more than one manifest (${manifests.length} manifests read).`);
console.log(`✅ No dependency has different specifiers across catalogs (${CATALOG_ALLOWLIST.size} allowlisted).`);
