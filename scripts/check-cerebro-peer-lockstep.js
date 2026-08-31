/**
 * Guards against `@lunora/cli`'s pins of `@bomb.sh/tab` / `@visulima/pail` drifting
 * away from `@visulima/cerebro`'s optional peers.
 *
 * cerebro declares those as peers, historically at exact versions. When the CLI's
 * own pin cannot satisfy that peer, published-CLI consumers under npm/yarn flat
 * hoisting end up with a single copy that cannot satisfy both, and `npx lunorash`
 * crashes at boot with `ERR_MODULE_NOT_FOUND` (cerebro's completion command
 * top-level-imports tab).
 *
 * This exact bug was fixed in commit e323725a0 ("fix(cli): align @bomb.sh/tab pin
 * with cerebro peer") and was regressed nine hours later by a routine deps bump.
 * Run on every `pnpm install` via the root `postinstall` script so it can't
 * silently regress again.
 *
 * Both guarded pins are `catalog:` refs, so the CLI side is resolved through
 * `pnpm-workspace.yaml` before comparing — a raw string comparison saw
 * `"catalog:cli"` against `"4.1.1"`, decided the pair was "not string-comparable"
 * and printed a success it had never verified, on every install.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { catalogs as readCatalogs } from "./workspace-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const cliDir = join(rootDir, "packages", "cli");

// Peers that cerebro declares and that the CLI also declares.
const GUARDED_PACKAGES = ["@bomb.sh/tab", "@visulima/pail"];

const require = createRequire(import.meta.url);

/** A manifest specifier with any `catalog:` indirection followed, or undefined. */
const resolveSpecifier = (specifier, catalogs) => {
    if (typeof specifier !== "string" || !specifier.startsWith("catalog:")) {
        return specifier;
    }

    const name = specifier.slice("catalog:".length) || "default";

    return catalogs[name]?.[resolveSpecifier.package];
};

let cerebroManifest;

try {
    const cerebroManifestPath = require.resolve("@visulima/cerebro/package.json", { paths: [cliDir] });

    cerebroManifest = JSON.parse(readFileSync(cerebroManifestPath, "utf8"));
} catch {
    // Bootstrap tolerance, but only where bootstrap is a real state: mid-install
    // on a fresh clone. In CI the install has finished by the time postinstall
    // runs, so an unresolvable cerebro means the check cannot do its job — and a
    // gate that cannot run must not report green.
    const message = "@visulima/cerebro is not resolvable from packages/cli.";

    if (process.env.CI) {
        console.error(`❌ ${message} The peer lockstep check cannot run, so it fails rather than passing silently.`);
        process.exit(1);
    }

    console.log(`ℹ️  ${message} Install in progress? — skipping peer lockstep check.`);
    process.exit(0);
}

const catalogs = readCatalogs();
const cliManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

const cerebroPeers = cerebroManifest.peerDependencies || {};
const cliVersions = { ...cliManifest.dependencies, ...cliManifest.devDependencies };

const problems = [];
let compared = 0;

for (const name of GUARDED_PACKAGES) {
    const cerebroVersion = cerebroPeers[name];
    const rawCliVersion = cliVersions[name];

    if (!cerebroVersion || !rawCliVersion) {
        continue;
    }

    resolveSpecifier.package = name;

    const cliVersion = resolveSpecifier(rawCliVersion, catalogs);

    if (cliVersion === undefined) {
        problems.push(
            `❌ packages/cli's "${name}" is "${rawCliVersion}", which resolves to nothing in pnpm-workspace.yaml's catalogs.\n` +
                `   Add the entry, or pin the version literally — an unresolvable ref cannot be checked against cerebro's peer.`,
        );

        continue;
    }

    // `subset`, not string equality: cerebro pins some of these exactly
    // (`4.1.1`) and expresses others as a range (`>=0.0.16`). Either way the
    // question is the same — can every version the CLI's pin admits satisfy the
    // peer? An unparseable range on either side is a failure, not a stand-down.
    if (semver.validRange(cliVersion) === null || semver.validRange(cerebroVersion) === null) {
        problems.push(`❌ ${name}: cli "${cliVersion}" or cerebro peer "${cerebroVersion}" is not a valid semver range — cannot verify lockstep.`);

        continue;
    }

    compared += 1;

    if (!semver.subset(cliVersion, cerebroVersion)) {
        problems.push(
            `❌ packages/cli's "${name}" (${cliVersion}${rawCliVersion === cliVersion ? "" : ` via ${rawCliVersion}`}) does not satisfy @visulima/cerebro's peer (${cerebroVersion}).\n` +
                `   Pin it to a range inside ${cerebroVersion} (see commit e323725a0).`,
        );
    }
}

if (problems.length > 0) {
    for (const problem of problems) {
        console.error(problem);
    }

    process.exit(1);
}

if (compared !== GUARDED_PACKAGES.length) {
    console.error(`❌ Only ${compared} of ${GUARDED_PACKAGES.length} guarded pins were comparable against @visulima/cerebro's peers.`);
    console.error("   GUARDED_PACKAGES lists a dependency that packages/cli or cerebro no longer declares — update the list.");
    process.exit(1);
}

console.log(`✅ packages/cli's ${GUARDED_PACKAGES.join(" and ")} pins satisfy @visulima/cerebro's peers.`);
