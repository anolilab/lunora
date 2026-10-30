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
 * 1. vis.config.ts sets `internalDependencyRanges: "preserve-satisfying"`, so the
 *    release keeps a sibling range that still admits the new version (vis's default
 *    would write `>=<new version>` and drop the ceiling); this guard fails on an
 *    unbounded sibling peer range as a backstop. Exact pins become `^<new version>`.
 *    `updateInternalDependencies: "out-of-range"` (asserted below) keeps a satisfied
 *    range from cascading a release to its consumer.
 *
 * 2. npm-semver prerelease matching is tuple-scoped: `>=1.0.0-alpha.24 <2.0.0-0`
 *    does NOT match a post-stable prerelease like `1.0.1-alpha.1`. If the alpha
 *    train continues past `1.0.0`, the release rewrites that range, and this guard
 *    fails the next install so a maintainer restores a bounded range.
 *
 * A second, report-only mode covers exact sibling `dependencies` pins (as
 * opposed to `peerDependencies`). Exact-pinned regular dependencies are this
 * repo's *deliberate* lockstep convention (see point 1 above) — the release
 * rewrites them to `^<new version>` whenever the CONSUMER package itself releases. But a
 * consumer with no triggering commits since its dependency's last release
 * keeps its stale pin indefinitely — the terminal case is a `private: true`
 * package that never releases at all. For a published sibling that drift means
 * two installers of two different `@lunora/*` packages can resolve two physical
 * copies of a shared dependency. For published packages this mode never fails
 * the install — it only reports — because mid-release-train drift between
 * trains is normal and expected.
 *
 * Private packages are the exception and DO fail the install: nothing ever
 * rewrites their pins. The root `pnpm-workspace.yaml` overrides force every
 * sibling to `workspace:*` at install time, so a stale pin still links the
 * workspace copy today — but the manifest then disagrees with the lockfile, and
 * if those overrides are ever removed the stale pin resolves from the registry
 * (a bundled private package such as `@lunora/dispatch` would inline that copy
 * into the published packages that bundle it). The manifest should say what is
 * installed, so any sibling specifier in a private package's dependency fields
 * that is not `workspace:` or `catalog:` fails — on the shape, not on current
 * drift. (`workspace:*` peers pass the exact-pin peer check above.)
 *
 * The same report covers sibling `>=<floor>` RANGES (used for `@lunora/errors`
 * so every sibling dedupes onto one `LunoraError` class). The release never raises
 * a floor the new version still satisfies, so a floor below the dependency's
 * current version is reported for a maintainer to raise by hand.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");

/** Matches an exact, range-free semver literal (`1.0.0`, `1.0.0-alpha.24`). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Captures the floor of a `>=<floor> …` or `^<floor>` range (`>=1.0.0-alpha.51 <2.0.0-0`). */
const RANGE_FLOOR_RE = /^(?:>=|\^)\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/;

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
        if (!isSibling(name) || typeof specifier !== "string") {
            continue;
        }

        // The shape vis writes for a range it does not preserve: floor ratcheted, ceiling dropped.
        if (specifier.startsWith(">=") && !specifier.includes("<")) {
            hasFailure = true;

            console.error(`❌ packages/${dir}'s peerDependency "${name}" has no upper bound (${specifier}).`);
            console.error('   The release rewrote a sibling range; restore the previous range, e.g. ">=<floor> <2.0.0-0".');

            continue;
        }

        if (!EXACT_VERSION_RE.test(specifier)) {
            continue;
        }

        hasFailure = true;

        console.error(`❌ packages/${dir}'s peerDependency "${name}" is an exact pin (${specifier}).`);
        console.error(`   Exact sibling peers break on the next release of ${name} (and on 1.0 promotion).`);
        console.error(`   Use a range instead, e.g. ">=${specifier} <2.0.0-0".`);
    }
}

// Private packages: any non-workspace/catalog sibling specifier fails — nothing
// rewrites it on release, and only the root overrides keep it on the workspace copy.
for (const { dir, manifest } of manifests) {
    if (manifest.private !== true) {
        continue;
    }

    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
            if (!isSibling(name) || typeof specifier !== "string" || specifier.startsWith("workspace:") || specifier.startsWith("catalog:")) {
                continue;
            }

            hasFailure = true;

            console.error(`❌ packages/${dir} is private but its ${field} pin "${name}": "${specifier}".`);
            console.error("   A private package never releases, so nothing rewrites the pin; the manifest should match the workspace:* install.");
            console.error(`   Use "${name}": "workspace:*" instead.`);
        }
    }
}

// Report-only: exact sibling `dependencies` pins in published packages that have
// drifted behind the dependency's current published version. Never fails the
// install — see the doc comment above for why this is a report, not a gate.
let dependencyWarnings = 0;

for (const { dir, manifest } of manifests) {
    if (manifest.private === true) {
        continue;
    }

    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
        if (!isSibling(name) || typeof specifier !== "string" || specifier.startsWith("workspace:")) {
            continue;
        }

        const current = versions[name];
        const floor = EXACT_VERSION_RE.test(specifier) ? specifier : RANGE_FLOOR_RE.exec(specifier)?.[1];

        if (!current || !floor || !semver.lt(floor, current)) {
            continue;
        }

        dependencyWarnings += 1;

        console.warn(`⚠️  packages/${dir} depends on "${name}": "${specifier}" — current is "${current}".`);
    }
}

if (dependencyWarnings > 0) {
    console.warn(
        `⚠️  ${dependencyWarnings} sibling dependency pin(s)/range floor(s) are behind the current published version (report-only, does not fail install).`,
    );
}

// Read as text: vis.config.ts is TypeScript, and this runs from `postinstall`, where a failure
// turns every CI job red in its setup step.
try {
    const visConfig = readFileSync(join(rootDir, "vis.config.ts"), "utf8");

    if (!/updateInternalDependencies:\s*"out-of-range"/.test(visConfig)) {
        hasFailure = true;

        console.error('❌ vis.config.ts no longer sets release.updateInternalDependencies: "out-of-range".');
        console.error("   Without it, every release of a sibling also releases each package that peers on it through a range.");
    }
} catch {
    hasFailure = true;

    console.error("❌ vis.config.ts is missing or unreadable.");
    console.error('   Its release block must set updateInternalDependencies: "out-of-range".');
}

if (hasFailure) {
    process.exit(1);
}

console.log(
    '✅ No exact or unbounded @lunora/* or lunorash peerDependency ranges; private packages use workspace:/catalog: siblings; updateInternalDependencies: "out-of-range".',
);
