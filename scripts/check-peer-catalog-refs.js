/**
 * Guards against a `catalog:` specifier appearing in `peerDependencies`.
 *
 * A `catalog:` reference is the right thing in `dependencies` /
 * `devDependencies` — it is how this repo pins one version of a shared
 * dependency in `pnpm-workspace.yaml` and references it everywhere (`CLAUDE.md`'s
 * "Dependency Catalog" rule). In `peerDependencies` it is a trap, because the
 * two fields mean opposite things:
 *
 * - a devDependency says "this is the version WE build and test against";
 * - a peerDependency says "this is the version range a CONSUMER must satisfy".
 *
 * pnpm resolves `catalog:` at publish time, so a catalogued peer ships the
 * catalog's current value as the consumer's hard requirement. Every routine
 * catalog bump then silently re-narrows what already-published consumers are
 * allowed to install, and an exact-pinned catalog entry publishes as an exact
 * peer — "you must use our dev version, to the patch".
 *
 * Why CI could never catch this on its own: pnpm only WARNS on an unmet peer, so
 * the whole workspace (and the template smoke matrix) stays green. npm 7+ errors
 * with ERESOLVE. The failure therefore lands exclusively on end users — the
 * people running `lunora init` and `npm install` — and never on us.
 *
 * That is not hypothetical. `@lunora/vite` peered `vite: "catalog:vite"`, which
 * published as `^8.1.5`, while the plugin's own `@cloudflare/vite-plugin`
 * dependency declares `^6.1.0 || ^7.0.0 || ^8.0.0` and its only vite value
 * import (`isRunnableDevEnvironment`) has existed since Vite 6. `templates/analog`
 * ran Vite 6 (Angular's `@angular/build` pinned it there), so a scaffolded analog
 * app could not `npm install` at all:
 *
 *     npm error ERESOLVE unable to resolve dependency tree
 *     npm error Found: vite@6.4.3
 *     npm error   peer vite@"^8.1.5" from @lunora/vite@1.0.0-alpha.137
 *
 * Nine more peers across `@lunora/ai`, `@lunora/auth`, `@lunora/flags`,
 * `@lunora/server` and `@lunora/testing` had the same shape; two of them
 * (`@ai-sdk/anthropic`, `better-auth`) published as exact versions.
 *
 * The fix is always the same: write the peer literally — floor at the lowest
 * version already published as a peer so no existing consumer is narrowed out,
 * cap at the major boundary — and leave the devDependency on `catalog:` so what
 * we develop against is unchanged.
 *
 * Neighbouring guards deliberately do not cover this:
 * `check-catalog-drift.js` walks only `dependencies` / `devDependencies`, and
 * `check-sibling-peer-ranges.js` only covers `@lunora/*` / `lunorash` siblings.
 *
 * Run: node scripts/check-peer-catalog-refs.js
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace globs that hold publishable manifests (`templates/*` are standalone, not workspace members). */
const WORKSPACE_DIRS = ["apps", "packages", "examples", "tests"];

/** Every `<workspace-dir>/<name>/package.json` that exists, plus the repo root manifest. */
const manifestPaths = () => {
    const found = [join(rootDir, "package.json")];

    for (const parent of WORKSPACE_DIRS) {
        const parentPath = join(rootDir, parent);

        let entries = [];

        try {
            entries = readdirSync(parentPath);
        } catch {
            continue;
        }

        for (const entry of entries) {
            const manifest = join(parentPath, entry, "package.json");

            try {
                if (statSync(manifest).isFile()) {
                    found.push(manifest);
                }
            } catch {
                // Not a package directory — skip.
            }
        }
    }

    return found;
};

const offenders = [];

for (const manifest of manifestPaths()) {
    let pkg;

    try {
        pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
        continue;
    }

    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
        if (typeof range === "string" && range.startsWith("catalog:")) {
            offenders.push({ name, package: pkg.name ?? manifest, range, relative: manifest.slice(rootDir.length + 1) });
        }
    }
}

if (offenders.length > 0) {
    console.error(`❌ ${offenders.length} peerDependency${offenders.length === 1 ? "" : "s"} reference${offenders.length === 1 ? "s" : ""} a catalog:`);
    console.error("");

    for (const offender of offenders) {
        console.error(`   ${offender.relative}`);
        console.error(`     "${offender.name}": "${offender.range}"`);
    }

    console.error("");
    console.error("   A `catalog:` peer publishes OUR dev pin as the range consumers must satisfy, so every");
    console.error("   catalog bump silently re-narrows already-published consumers. pnpm only warns on an unmet");
    console.error("   peer, so this stays invisible here and lands on npm users as an ERESOLVE install failure.");
    console.error("");
    console.error("   Write the peer literally instead: floor at the lowest version already published as a peer,");
    console.error("   cap at the major boundary (e.g. `^6.1.0 || ^7.0.0 || ^8.0.0`). Keep the devDependency on");
    console.error("   `catalog:` so what we build and test against does not change.");

    process.exit(1);
}

console.log("✅ No peerDependency references a catalog: specifier.");
