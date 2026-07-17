/**
 * Guards against `@lunora/*` / `lunorash` sibling peerDependencies regressing to
 * EXACT version pins (`1.0.0-alpha.24`) instead of promotion-safe ranges
 * (`>=1.0.0-alpha.24 <2.0.0-0`).
 *
 * An exact sibling peer pin breaks the moment the sibling publishes any other
 * version — most catastrophically the `1.0.0-alpha.N → 1.0.0` stable promotion,
 * where every published consumer of the pinned package becomes uninstallable.
 * A `>=<floor> <2.0.0-0` range matches newer same-tuple prereleases
 * (`1.0.0-alpha.30`), the stable `1.0.0`, and every later `1.x`.
 *
 * Two mechanisms interact here:
 *
 * 1. multi-semantic-release rewrites local sibling specifiers on every release.
 *    Its default `deps.bump: "override"` replaces ANY specifier — ranges
 *    included — with the exact new version (that is how @lunora/replica's
 *    original `>=1.0.0-alpha.17 <2.0.0` peer got clobbered to `1.0.0-alpha.24`).
 *    The root `.multi-releaserc.json` therefore sets `deps.bump: "satisfy"`,
 *    which leaves a specifier alone while the new version still satisfies it
 *    (exact-pinned regular dependencies keep their lockstep bumps — an exact pin
 *    never satisfies the next version, so "satisfy" falls back to override).
 *
 * 2. npm-semver prerelease matching is tuple-scoped: `>=1.0.0-alpha.24 <2.0.0-0`
 *    does NOT match a post-stable prerelease like `1.0.1-alpha.1`. If the alpha
 *    train continues past `1.0.0`, "satisfy" falls back to an exact pin again —
 *    this guard then fails the next install so a maintainer widens the range
 *    floor instead of shipping a fresh time bomb.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");

/** Matches an exact, range-free semver literal (`1.0.0`, `1.0.0-alpha.24`). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

let hasFailure = false;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }

    const manifestPath = join(packagesDir, entry.name, "package.json");

    let manifest;

    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
        continue;
    }

    for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!isSibling(name) || typeof specifier !== "string" || !EXACT_VERSION_RE.test(specifier)) {
            continue;
        }

        hasFailure = true;

        console.error(`❌ packages/${entry.name}'s peerDependency "${name}" is an exact pin (${specifier}).`);
        console.error(`   Exact sibling peers break on the next release of ${name} (and on 1.0 promotion).`);
        console.error(`   Use a range instead, e.g. ">=${specifier} <2.0.0-0".`);
    }
}

// The range fix only holds while multi-semantic-release runs with
// `deps.bump: "satisfy"` — under the default "override" the next release
// rewrites every sibling range back to an exact pin. Fail if that config drifts.
try {
    const msrConfig = JSON.parse(readFileSync(join(rootDir, ".multi-releaserc.json"), "utf8"));

    if (msrConfig?.deps?.bump !== "satisfy") {
        hasFailure = true;

        console.error('❌ .multi-releaserc.json no longer sets "deps.bump": "satisfy".');
        console.error("   Without it, multi-semantic-release overrides sibling peer RANGES back to exact pins on the next release.");
    }
} catch {
    hasFailure = true;

    console.error("❌ .multi-releaserc.json is missing or unparsable.");
    console.error('   It must set "deps.bump": "satisfy" so sibling peer ranges survive releases.');
}

if (hasFailure) {
    process.exit(1);
}

console.log("✅ No exact @lunora/* or lunorash peerDependency pins; multi-semantic-release keeps ranges (deps.bump: satisfy).");
