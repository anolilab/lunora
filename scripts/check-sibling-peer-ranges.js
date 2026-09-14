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
 * 1. The release tool rewrites local sibling specifiers on every release. A mode
 *    that rewrites unconditionally replaces ANY specifier — ranges included —
 *    with the exact new version (that is how @lunora/replica's original
 *    `>=1.0.0-alpha.17 <2.0.0` peer got clobbered to `1.0.0-alpha.24`).
 *    `vis.config.ts` therefore sets `release.updateInternalDependencies:
 *    "out-of-range"`, which leaves a specifier alone while the new version still
 *    satisfies it (exact-pinned regular dependencies keep their lockstep bumps —
 *    an exact pin never satisfies the next version, so it is always rewritten).
 *    This was `.multi-releaserc.json`'s `deps.bump: "satisfy"` before the repo
 *    moved off multi-semantic-release; same rule, different spelling.
 *
 * 2. npm-semver prerelease matching is tuple-scoped: `>=1.0.0-alpha.24 <2.0.0-0`
 *    does NOT match a post-stable prerelease like `1.0.1-alpha.1`. If the alpha
 *    train continues past `1.0.0`, an in-range specifier becomes out-of-range and
 *    is pinned exactly again — this guard then fails the next install so a
 *    maintainer widens the range floor instead of shipping a fresh time bomb.
 *
 * A second, report-only mode covers exact sibling `dependencies` pins (as
 * opposed to `peerDependencies`). Exact-pinned regular dependencies are this
 * repo's *deliberate* lockstep convention (see point 1 above) — "satisfy"
 * bumps them in lockstep whenever the CONSUMER package itself releases. But a
 * consumer with no triggering commits since its dependency's last release
 * keeps its stale pin indefinitely — the terminal case is a `private: true`
 * package that never releases at all. That drift is invisible today (nothing
 * walks `dependencies`) and, for a published sibling, means two installers of
 * two different `@lunora/*` packages can resolve two physical copies of a
 * shared dependency. This mode never fails the install — it only reports —
 * because mid-release-train drift between trains is normal and expected.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfies } from "semver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");

/** Matches an exact, range-free semver literal (`1.0.0`, `1.0.0-alpha.24`). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

const packageDirs = readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

const manifests = [];
const versions = {};

for (const entry of packageDirs) {
    const manifestPath = join(packagesDir, entry.name, "package.json");

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

        manifests.push({ dir: entry.name, manifest });

        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
            versions[manifest.name] = manifest.version;
        }
    } catch {
        continue;
    }
}

let hasFailure = false;

for (const { dir, manifest } of manifests) {
    for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!isSibling(name) || typeof specifier !== "string" || !EXACT_VERSION_RE.test(specifier)) {
            continue;
        }

        hasFailure = true;

        console.error(`❌ packages/${dir}'s peerDependency "${name}" is an exact pin (${specifier}).`);
        console.error(`   Exact sibling peers break on the next release of ${name} (and on 1.0 promotion).`);
        console.error(`   Use a range instead, e.g. ">=${specifier} <2.0.0-0".`);
    }
}

// Report-only: sibling `dependencies` specifiers that no longer admit the
// dependency's current version. Never fails the install — see the doc comment
// above for why this is a report, not a gate.
//
// Satisfaction, not string equality: `vis release` rewrites an out-of-range
// sibling specifier to `^<new version>`, which keeps admitting the next alpha in
// the same tuple. Comparing strings would report every one of those as drifted
// on every install, for as long as they stay correct.
let dependencyWarnings = 0;

for (const { dir, manifest } of manifests) {
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
        if (!isSibling(name) || typeof specifier !== "string" || specifier.startsWith("workspace:")) {
            continue;
        }

        const current = versions[name];

        if (!current || satisfies(current, specifier, { includePrerelease: false })) {
            continue;
        }

        dependencyWarnings += 1;

        console.warn(`⚠️  packages/${dir} depends on "${name}": "${specifier}" — current is "${current}".`);
    }
}

if (dependencyWarnings > 0) {
    console.warn(`⚠️  ${dependencyWarnings} sibling dependency pin(s) are behind the current published version (report-only, does not fail install).`);
}

// The range fix only holds while the release tool leaves a satisfied specifier
// alone. In `vis release` that is `updateInternalDependencies: "out-of-range"` —
// the mode that rewrites a sibling specifier only when the new version no longer
// satisfies it. Under an unconditional mode the next release rewrites every
// sibling range back to an exact pin. Fail if that config drifts.
//
// Read as text, not imported: vis.config.ts is TypeScript, and this runs from
// `postinstall` where a failure turns every CI job red in its setup step.
try {
    const visConfig = readFileSync(join(rootDir, "vis.config.ts"), "utf8");

    if (!/updateInternalDependencies:\s*"out-of-range"/.test(visConfig)) {
        hasFailure = true;

        console.error('❌ vis.config.ts no longer sets release.updateInternalDependencies: "out-of-range".');
        console.error("   Without it, the release rewrites sibling peer RANGES back to exact pins on the next publish.");
    }
} catch {
    hasFailure = true;

    console.error("❌ vis.config.ts is missing or unreadable.");
    console.error('   Its release block must set updateInternalDependencies: "out-of-range" so sibling peer ranges survive releases.');
}

if (hasFailure) {
    process.exit(1);
}

console.log('✅ No exact @lunora/* or lunorash peerDependency pins; vis release keeps ranges (updateInternalDependencies: "out-of-range").');
