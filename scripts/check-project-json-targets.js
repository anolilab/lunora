/**
 * Guards against a `project.json` target that the task runner silently skips.
 *
 * vis reads a target's command from a top-level `command` key. nx reads it from
 * `executor` + `options.command`. A target that declares an `executor` and no
 * top-level `command` is not an error to vis — it reports
 * `No command configured for <project>:<target>` and exits 0, and because a
 * declared target shadows the `package.json` script it would otherwise fall
 * back to, the real command never runs.
 *
 * That is not hypothetical. Ten packages carried nx-shaped `lint:eslint`
 * targets — four of them still did when this check landed — so
 * `pnpm run lint:eslint` printed a green tick for each of them after ~13ms of
 * doing nothing, while real errors sat in their source. The aggregate run is a
 * required status check, so none of it gated anything. Worse, the nested
 * command (`eslint --config {workspaceRoot}/eslint.config.js`) named a root
 * config this repo does not have and dropped the `--max-warnings=0` the
 * manifest script carries, so it could never have worked even under nx.
 *
 * The fix in every case was to DELETE the block: with no target declared, vis
 * falls back to the `package.json` script, which is what most projects already
 * do. Two shapes are deliberately NOT rejected, both measured to run for real:
 *
 * - a config-only block (`cache` / `inputs` / `dependsOn`) — vis merges it onto
 *   the manifest script;
 * - `executor` alongside a top-level `command` — vis reads the `command` and
 *   ignores the rest, which is exactly what the error text below advises.
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
 * Projects still carrying a silently-skipped target, each with the change that
 * removes it. An entry here is a debt marker, not an exemption: the check also
 * fails when an allowlisted project is CLEAN or gone, so the entry cannot
 * outlive the fix it points at.
 */
const KNOWN_UNMIGRATED = new Map();

/**
 * The conventional `package.json` script set every `packages/*` workspace
 * member carries. `.vis/templates/lunora-package.ts` scaffolds all seven;
 * `test:coverage` missing it silently dropped a fresh package out of the CI
 * coverage leg with everything else staying green (plan 321).
 */
const REQUIRED_PACKAGE_SCRIPTS = ["build", "build:prod", "lint:eslint", "lint:prettier", "lint:types", "test", "test:coverage"];

/**
 * Packages exempt from part of `REQUIRED_PACKAGE_SCRIPTS`, each with the
 * missing script names and why. Same shape as `KNOWN_UNMIGRATED`: the check
 * fails if a listed script is no longer missing (stale entry) or the package
 * is gone, so this cannot silently grow into a way to skip build/lint/test.
 */
const KNOWN_SCRIPT_EXCEPTIONS = new Map([
    [
        "packages/auth-ui/package.json",
        {
            missing: ["build", "build:prod"],
            reason: "private, not published — ships raw .ts/.css source with no dist, so there is no build step by design",
        },
    ],
]);

/** The pnpm workspace globs, minus the trailing `/*` — every project.json lives under one. */
const WORKSPACE_DIRECTORIES = ["apps", "examples", "packages", "tests"];

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative paths of every project.json that exists. */
const projectFiles = [];
/** `path → parse error`. A guard against silent skips must not itself skip a file it cannot read. */
const malformed = new Map();
/** `path → [target names]` for every target vis would report as "No command configured". */
const offenders = new Map();

for (const workspace of WORKSPACE_DIRECTORIES) {
    let entries;

    try {
        entries = readdirSync(join(rootDir, workspace), { withFileTypes: true });
    } catch {
        continue;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const relativePath = `${workspace}/${entry.name}/project.json`;

        let raw;

        try {
            raw = readFileSync(join(rootDir, relativePath), "utf8");
        } catch {
            // No project.json in this directory — not every workspace member has one.
            continue;
        }

        projectFiles.push(relativePath);

        let manifest;

        try {
            manifest = JSON.parse(raw);
        } catch (error) {
            malformed.set(relativePath, error.message);
            continue;
        }

        const targets = manifest.targets ?? {};
        // An `executor` is only a problem when nothing else tells vis what to run.
        const skipped = Object.keys(targets).filter(
            (name) => typeof targets[name] === "object" && targets[name] !== null && "executor" in targets[name] && !("command" in targets[name]),
        );

        if (skipped.length > 0) {
            offenders.set(relativePath, skipped);
        }
    }
}

/** Repo-relative paths of every `package.json` under `packages/`. */
const packageManifests = [];
/** `path → parse error` for a `packages/` manifest that couldn't be read. */
const packageMalformed = new Map();
/** `path → scripts object`, for exemption-staleness checks below. */
const scriptsByPath = new Map();
/** `path → [required script names actually missing, after exemptions]`. */
const missingScripts = new Map();

let packageEntries;

try {
    packageEntries = readdirSync(join(rootDir, "packages"), { withFileTypes: true });
} catch {
    packageEntries = [];
}

for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
        continue;
    }

    const relativePath = `packages/${entry.name}/package.json`;

    let raw;

    try {
        raw = readFileSync(join(rootDir, relativePath), "utf8");
    } catch {
        continue;
    }

    packageManifests.push(relativePath);

    let manifest;

    try {
        manifest = JSON.parse(raw);
    } catch (error) {
        packageMalformed.set(relativePath, error.message);
        continue;
    }

    const scripts = manifest.scripts ?? {};

    scriptsByPath.set(relativePath, scripts);

    const exempt = new Set(KNOWN_SCRIPT_EXCEPTIONS.get(relativePath)?.missing ?? []);
    const missing = REQUIRED_PACKAGE_SCRIPTS.filter((name) => !(name in scripts) && !exempt.has(name));

    if (missing.length > 0) {
        missingScripts.set(relativePath, missing);
    }
}

const scriptExceptionsGone = [...KNOWN_SCRIPT_EXCEPTIONS.keys()].filter((path) => !packageManifests.includes(path));
// `scriptsByPath` only gets an entry once a package.json's JSON.parse
// succeeds (see the loop above); a KNOWN_SCRIPT_EXCEPTIONS entry whose
// package.json exists but fails to parse is still in `packageManifests`
// (pushed before the parse), so without the `!packageMalformed.has(path)`
// guard `scriptsByPath.get(path)` returns `undefined` and `name in undefined`
// throws — masking the already-collected, already-reported parse error
// (below) behind an uncaught TypeError instead.
const scriptExceptionsStale = [...KNOWN_SCRIPT_EXCEPTIONS.entries()]
    .filter(([path]) => packageManifests.includes(path) && !packageMalformed.has(path))
    .map(([path, { missing }]) => ({ nowPresent: missing.filter((name) => name in scriptsByPath.get(path)), path }))
    .filter(({ nowPresent }) => nowPresent.length > 0);

const unexpected = [...offenders.keys()].filter((path) => !KNOWN_UNMIGRATED.has(path));
const allowedButGone = [...KNOWN_UNMIGRATED.keys()].filter((path) => !projectFiles.includes(path));
const allowedButClean = [...KNOWN_UNMIGRATED.keys()].filter((path) => projectFiles.includes(path) && !offenders.has(path));

let failed = false;

if (malformed.size > 0) {
    failed = true;

    console.error(`❌ ${malformed.size} project.json file(s) could not be parsed, so their targets could not be checked:`);

    for (const [path, message] of malformed) {
        console.error(`   ${path} — ${message}`);
    }
}

if (unexpected.length > 0) {
    failed = true;

    console.error(`❌ ${unexpected.length} project.json file(s) declare a target with an \`executor\` and no \`command\`, which vis skips silently:`);

    for (const path of unexpected) {
        console.error(`   ${path} → ${offenders.get(path).join(", ")}`);
    }

    console.error("   Delete the `targets` block so vis falls back to the package.json script,");
    console.error("   or give the target a top-level `command` (vis's shape).");
    console.error("   Leaving it turns the project's gate into a ~13ms no-op that still reports success.");
}

if (allowedButGone.length > 0) {
    failed = true;

    console.error(`❌ ${allowedButGone.length} entr(y/ies) in KNOWN_UNMIGRATED name a project.json that no longer exists:`);

    for (const path of allowedButGone) {
        console.error(`   ${path} — deleted or renamed; update scripts/check-project-json-targets.js`);
    }
}

if (allowedButClean.length > 0) {
    failed = true;

    console.error(`❌ ${allowedButClean.length} entr(y/ies) in KNOWN_UNMIGRATED describe an already-clean project:`);

    for (const path of allowedButClean) {
        console.error(`   ${path} — remove it from scripts/check-project-json-targets.js`);
    }
}

if (packageMalformed.size > 0) {
    failed = true;

    console.error(`❌ ${packageMalformed.size} packages/*/package.json file(s) could not be parsed:`);

    for (const [path, message] of packageMalformed) {
        console.error(`   ${path} — ${message}`);
    }
}

if (missingScripts.size > 0) {
    failed = true;

    console.error(`❌ ${missingScripts.size} packages/*/package.json file(s) are missing a required script:`);

    for (const [path, scripts] of missingScripts) {
        console.error(`   ${path} → ${scripts.join(", ")}`);
    }

    console.error(`   Required: ${REQUIRED_PACKAGE_SCRIPTS.join(", ")}.`);
    console.error("   Add the missing script(s), or — if the package structurally has no build/dist step —");
    console.error("   add a documented entry to KNOWN_SCRIPT_EXCEPTIONS.");
}

if (scriptExceptionsGone.length > 0) {
    failed = true;

    console.error(`❌ ${scriptExceptionsGone.length} entr(y/ies) in KNOWN_SCRIPT_EXCEPTIONS name a package.json that no longer exists:`);

    for (const path of scriptExceptionsGone) {
        console.error(`   ${path} — deleted or renamed; update scripts/check-project-json-targets.js`);
    }
}

if (scriptExceptionsStale.length > 0) {
    failed = true;

    console.error(`❌ ${scriptExceptionsStale.length} entr(y/ies) in KNOWN_SCRIPT_EXCEPTIONS are stale (the script now exists):`);

    for (const { nowPresent, path } of scriptExceptionsStale) {
        console.error(`   ${path} → ${nowPresent.join(", ")} — remove from the exception's \`missing\` list`);
    }
}

if (failed) {
    process.exit(1);
}

if (offenders.size > 0) {
    console.log(`⚠️  ${offenders.size} project(s) still carry a silently-skipped target and are NOT gated:`);

    for (const [path, targets] of offenders) {
        console.log(`   ${path} (${targets.join(", ")}) — ${KNOWN_UNMIGRATED.get(path)}`);
    }
}

console.log(`✅ ${projectFiles.length - offenders.size} of ${projectFiles.length} project.json files declare no silently-skipped target.`);
console.log(`✅ ${packageManifests.length - missingScripts.size} of ${packageManifests.length} packages/*/package.json files carry the required script set.`);
