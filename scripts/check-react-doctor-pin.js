// @ts-check
/**
 * Hold `.github/workflows/react-doctor.yml`'s pinned tool version equal to
 * `react-doctor` in `catalog:lint`.
 *
 * The action installs the tool itself from its `version` input; the repo
 * installs it from the catalog. Nothing tied the two together, and they have now
 * drifted twice — first two minors apart, which made CI report a dozen
 * `react-compiler-no-manual-memoization` findings that did not exist on the
 * installed version, then 0.9.11 against a 0.9.13 catalog. Both times the
 * symptom was the same and the worst possible one for a linter: CI and a local
 * run disagreeing about what the codebase says, with no way to tell which is
 * right without reading two files nobody thinks to compare.
 *
 * A regex, not a YAML parse: the one line this needs is unambiguous, and the
 * workflow is quoted-key YAML that a naive parse would have to be taught. The
 * failure mode of the regex is "cannot find the pin", which this reports as an
 * error rather than passing vacuously — the shape that let the original drift
 * through.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/react-doctor.yml";
const catalogPath = "pnpm-workspace.yaml";

const workflow = readFileSync(join(rootDir, workflowPath), "utf8");
const catalog = readFileSync(join(rootDir, catalogPath), "utf8");

/** The `version:` input on the react-doctor action step. */
const pinned = /"version":\s*"([^"]+)"/u.exec(workflow)?.[1];

/** `react-doctor: <version>` under a catalog. Quoted or bare, since both forms appear in this file. */
const cataloged = /^\s*"?react-doctor"?:\s*"?([^"\s]+)"?\s*$/mu.exec(catalog)?.[1];

if (pinned === undefined) {
    console.error(`❌ Could not find the pinned react-doctor version in ${workflowPath}.`);
    console.error("");
    console.error('   Expected a `"version": "x.y.z"` input on the millionco/react-doctor step.');
    console.error("   If that step moved or was renamed, update this check with it.");

    process.exit(1);
}

if (cataloged === undefined) {
    console.error(`❌ Could not find \`react-doctor\` in ${catalogPath}'s catalogs.`);

    process.exit(1);
}

if (pinned !== cataloged) {
    console.error("❌ react-doctor is pinned to two different versions:");
    console.error("");
    console.error(`   ${workflowPath}   ${pinned}   (what CI runs)`);
    console.error(`   ${catalogPath}          ${cataloged}   (what the repo installs)`);
    console.error("");
    console.error("   CI and a local run will disagree about what the codebase reports —");
    console.error("   findings that exist on one version and not the other get regenerated");
    console.error("   on every `.tsx` pull request. Set both to the same version.");
    console.error("");
    console.error("   The action validates the tool's report against a fixed set of");
    console.error("   `schemaVersion`s, so check the action's tag supports the newer tool");
    console.error("   before bumping the catalog past it.");

    process.exit(1);
}

console.log(`✅ react-doctor is pinned to ${pinned} in both the workflow and catalog:lint.`);
