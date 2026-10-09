/**
 * Fails when the `lunorash` umbrella pins a sibling `@lunora/*` dependency to a
 * version other than the one the workspace currently publishes (#1054).
 *
 * The umbrella pins its siblings exactly, and multi-semantic-release only bumps
 * those pins when it releases the umbrella in the same run. When the umbrella is
 * not bumped, an app that installs the latest alphas gets two copies of
 * `@lunora/server` and `@lunora/values`, and `tsc` fails with no hint why. This
 * runs after the release in CI so that lag fails the run instead of shipping.
 *
 * Exact pins must equal the current version. Range pins must still be satisfied
 * by it. `workspace:` specifiers are not checked.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

/** Matches an exact, range-free semver literal (`1.0.0`, `1.0.0-alpha.24`). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * The umbrella's drifted `@lunora/*` dependencies: those whose pinned specifier
 * the workspace's current version does not satisfy.
 */
export const findUmbrellaPinDrift = (umbrella, versions) => {
    const drift = [];

    for (const [name, specifier] of Object.entries(umbrella.dependencies ?? {})) {
        const current = versions[name];

        if (!name.startsWith("@lunora/") || current === undefined || typeof specifier !== "string" || specifier.startsWith("workspace:")) {
            continue;
        }

        const satisfied = EXACT_VERSION_RE.test(specifier) ? specifier === current : semver.satisfies(current, specifier);

        if (!satisfied) {
            drift.push({ current, name, pinned: specifier });
        }
    }

    return drift;
};

const main = () => {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const packagesDir = join(rootDir, "packages");
    const versions = {};

    for (const entry of readdirSync(packagesDir, { withFileTypes: true }).filter((item) => item.isDirectory())) {
        try {
            const manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));

            if (typeof manifest.name === "string" && typeof manifest.version === "string") {
                versions[manifest.name] = manifest.version;
            }
        } catch {
            continue;
        }
    }

    const umbrella = JSON.parse(readFileSync(join(packagesDir, "lunora", "package.json"), "utf8"));
    const drift = findUmbrellaPinDrift(umbrella, versions);

    if (drift.length === 0) {
        console.log(`✅ lunorash pins every @lunora/* sibling to a version the workspace publishes.`);

        return;
    }

    for (const { current, name, pinned } of drift) {
        console.error(`❌ lunorash pins ${name} at ${pinned}, but the workspace publishes ${current}.`);
    }

    console.error("   The umbrella was not re-released with its siblings (#1054). Release lunorash so its pins match.");
    process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
