/**
 * Guards against the PR-title gate and commitlint disagreeing about which
 * conventional-commit types this repo accepts.
 *
 * `.github/workflows/semantic-pull-request.yml` is a REQUIRED check, and on a
 * squash merge the PR title becomes the commit message — with the `commit-msg`
 * hook nowhere in sight, because hooks do not run server-side. So that list is
 * the real type gate for everything that lands, and it is a hand-kept second
 * copy of commitlint's `type-enum`.
 *
 * It had drifted in both directions at once: the workflow allowed `infra`, which
 * commitlint rejects and semantic-release cannot map to a release, and rejected
 * `deps`, `security`, `style` and `translation`, all four of them valid types
 * documented in `CLAUDE.md`. Neither direction failed anything until someone
 * used one.
 *
 * The workflow cannot derive the list at runtime — it is a `pull_request_target`
 * job with no checkout and no install, deliberately, because checking out and
 * executing PR code under that trigger is how a fork takes the repo's write
 * token. So the copy stays, and this compares it.
 *
 * Run: node scripts/check-pr-title-types.js
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(rootDir, ".github/workflows/semantic-pull-request.yml");

/** The `types: |` block literal from the action's `with:` mapping. */
const workflowTypes = () => {
    const source = readFileSync(workflowPath, "utf8");
    const block = /^(\s+)"types": \|\n([\s\S]*?)(?=^\1"|^\s*- |^\s*$)/mu.exec(source);

    if (block === null) {
        throw new Error('check-pr-title-types: no `"types": |` block literal in .github/workflows/semantic-pull-request.yml');
    }

    return block[2]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
};

/**
 * `@commitlint/load` is a dependency of `@commitlint/cli`, not of this repo, so
 * it is invisible from the root under pnpm's strict node_modules. Resolve it
 * from the CLI the repo does depend on rather than adding a manifest entry for
 * an internal of a tool already installed.
 */
const commitlintTypes = async () => {
    const require = createRequire(import.meta.url);
    const commitlintCli = dirname(require.resolve("@commitlint/cli/package.json"));
    const loadModule = await import(pathToFileURL(createRequire(join(commitlintCli, "package.json")).resolve("@commitlint/load")).href);
    const load = loadModule.default?.default ?? loadModule.default;

    const { rules } = await load({}, { cwd: rootDir });
    const rule = rules["type-enum"];

    if (!Array.isArray(rule) || !Array.isArray(rule[2])) {
        throw new Error("check-pr-title-types: commitlint resolved no `type-enum` rule");
    }

    return [...rule[2]].sort();
};

const inWorkflow = workflowTypes();
const inCommitlint = await commitlintTypes();

const extra = inWorkflow.filter((type) => !inCommitlint.includes(type));
const missing = inCommitlint.filter((type) => !inWorkflow.includes(type));

if (extra.length > 0 || missing.length > 0) {
    console.error("❌ The PR-title gate and commitlint disagree about the accepted commit types.");
    console.error("");

    if (extra.length > 0) {
        console.error(`   Accepted by the workflow, rejected by commitlint: ${extra.join(", ")}`);
        console.error("   A squash merge turns the PR title into a commit of a type semantic-release cannot map.");
    }

    if (missing.length > 0) {
        console.error(`   Accepted by commitlint, rejected by the workflow: ${missing.join(", ")}`);
        console.error("   A valid commit type fails a required check today.");
    }

    console.error("");
    console.error("   Fix the `types:` block in .github/workflows/semantic-pull-request.yml to match commitlint's");
    console.error("   `type-enum` exactly. commitlint is the source of truth — the workflow is the copy.");

    process.exit(1);
}

console.log(`✅ The PR-title gate accepts exactly commitlint's ${inCommitlint.length} types.`);
