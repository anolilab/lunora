/**
 * Guards against a `project.json` target that the task runner silently skips.
 *
 * vis reads a target's command from a top-level `command` key. nx reads it from
 * `executor` + `options.command`. A target written in the nx shape is not an
 * error to vis — it reports `No command configured for <project>:<target>` and
 * exits 0, and because a declared target shadows the `package.json` script it
 * would otherwise fall back to, the real command never runs.
 *
 * That is not hypothetical. Ten packages carried nx-shaped `lint:eslint`
 * targets, so `pnpm run lint:eslint` printed a green tick for each of them
 * after ~13ms of doing nothing — while 523 real errors sat in their source.
 * The aggregate run is a required status check, so none of it gated anything.
 * Worse, the nested command (`eslint --config {workspaceRoot}/eslint.config.js`)
 * named a root config this repo does not have and dropped the
 * `--max-warnings=0` the manifest script carries, so it could never have worked
 * even under nx.
 *
 * The fix in every case was to DELETE the block: with no target declared, vis
 * falls back to the `package.json` script, which is what 48 of the 58 projects
 * already do. A config-only block (`cache` / `inputs` / `dependsOn`, no
 * `executor`, no `command`) is fine — vis merges it onto the manifest script —
 * so only `executor`-bearing targets are rejected here.
 *
 * Runs as the first step of the Lint workflow's eslint job, and via
 * `pnpm run lint:project-json`. Deliberately NOT in the root `postinstall`: a
 * failing postinstall check fails every CI job in its setup step, which buries
 * the cause.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Projects still carrying an `executor`-bearing target, each with the change
 * that removes it. An entry here is a debt marker, not an exemption: the check
 * also fails when an allowlisted project is CLEAN, so the entry cannot outlive
 * the fix it points at.
 */
const KNOWN_UNMIGRATED = new Map([["packages/svelte/project.json", "plan 302 phase 6 — un-skip once its eslint findings are cleared"]]);

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = ["packages", "apps"];

/** Every `<workspace>/<project>/project.json` that exists, as repo-relative paths. */
const projectFiles = workspaceDirectories.flatMap((workspace) => {
    let entries;

    try {
        entries = readdirSync(join(rootDir, workspace), { withFileTypes: true });
    } catch {
        return [];
    }

    return entries.filter((entry) => entry.isDirectory()).map((entry) => `${workspace}/${entry.name}/project.json`);
});

const offenders = new Map();

for (const relativePath of projectFiles) {
    let manifest;

    try {
        manifest = JSON.parse(readFileSync(join(rootDir, relativePath), "utf8"));
    } catch {
        continue;
    }

    const targets = manifest.targets ?? {};
    const nxShaped = Object.keys(targets).filter((name) => typeof targets[name] === "object" && targets[name] !== null && "executor" in targets[name]);

    if (nxShaped.length > 0) {
        offenders.set(relativePath, nxShaped);
    }
}

const unexpected = [...offenders.keys()].filter((path) => !KNOWN_UNMIGRATED.has(path));
const staleAllowances = [...KNOWN_UNMIGRATED.keys()].filter((path) => !offenders.has(path));

if (unexpected.length > 0) {
    console.error(`❌ ${unexpected.length} project.json file(s) declare a target in nx's \`executor\` shape, which vis skips silently:`);

    for (const path of unexpected) {
        console.error(`   ${path} → ${offenders.get(path).join(", ")}`);
    }

    console.error("   Delete the `targets` block so vis falls back to the package.json script,");
    console.error("   or rewrite the target with a top-level `command` (vis's shape).");
    console.error("   Leaving it turns the project's gate into a ~13ms no-op that still reports success.");

    process.exit(1);
}

if (staleAllowances.length > 0) {
    console.error(`❌ ${staleAllowances.length} entr(y/ies) in KNOWN_UNMIGRATED no longer describe anything:`);

    for (const path of staleAllowances) {
        console.error(`   ${path} — already clean; remove it from scripts/check-project-json-targets.js`);
    }

    process.exit(1);
}

if (offenders.size > 0) {
    console.log(`⚠️  ${offenders.size} project(s) still carry an nx-shaped target and are NOT gated:`);

    for (const [path, targets] of offenders) {
        console.log(`   ${path} (${targets.join(", ")}) — ${KNOWN_UNMIGRATED.get(path)}`);
    }
}

console.log(`✅ ${projectFiles.length - offenders.size} of ${projectFiles.length} project.json files declare no silently-skipped target.`);
