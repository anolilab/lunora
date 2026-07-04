/**
 * Guards against `@lunora/cli`'s pins of `@bomb.sh/tab` / `@visulima/pail` drifting
 * away from `@visulima/cerebro`'s exact-version optional peers.
 *
 * cerebro declares those as **exact-version** optional peers. When the CLI's own
 * pin differs, published-CLI consumers under npm/yarn flat hoisting end up with a
 * single copy that cannot satisfy both, and `npx lunorash` crashes at boot with
 * `ERR_MODULE_NOT_FOUND` (cerebro's completion command top-level-imports tab).
 *
 * This exact bug was fixed in commit e323725a0 ("fix(cli): align @bomb.sh/tab pin
 * with cerebro peer") and was regressed nine hours later by a routine deps bump.
 * Run on every `pnpm install` via the root `postinstall` script so it can't
 * silently regress again.
 *
 * Never blocks bootstrap: if cerebro isn't resolvable yet (fresh clone mid
 * install), this prints a notice and exits 0.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const cliDir = join(rootDir, "packages", "cli");

// Peers that cerebro pins to an exact version and that the CLI also declares.
const GUARDED_PACKAGES = ["@bomb.sh/tab", "@visulima/pail"];

const require = createRequire(import.meta.url);

let cerebroManifest;

try {
    const cerebroManifestPath = require.resolve("@visulima/cerebro/package.json", { paths: [cliDir] });

    cerebroManifest = JSON.parse(readFileSync(cerebroManifestPath, "utf8"));
} catch {
    console.log("ℹ️  @visulima/cerebro is not resolvable yet (install in progress?) — skipping peer lockstep check.");
    process.exit(0);
}

const cliManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

const cerebroPeers = cerebroManifest.peerDependencies || {};
const cliVersions = { ...cliManifest.dependencies, ...cliManifest.devDependencies };

let hasMismatch = false;

for (const name of GUARDED_PACKAGES) {
    const cerebroVersion = cerebroPeers[name];
    const cliVersion = cliVersions[name];

    if (!cerebroVersion || !cliVersion) {
        continue;
    }

    if (cliVersion !== cerebroVersion) {
        hasMismatch = true;

        console.error(`❌ packages/cli's "${name}" (${cliVersion}) does not match @visulima/cerebro's peer (${cerebroVersion}).`);
        console.error(`   Pin packages/cli's ${name} to ${cerebroVersion} (see commit e323725a0).`);
    }
}

if (hasMismatch) {
    process.exit(1);
}

console.log("✅ packages/cli's @bomb.sh/tab and @visulima/pail pins match @visulima/cerebro's peers.");
