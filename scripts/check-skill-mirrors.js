/**
 * Guards the first-party Agent Skill mirrors against silent rot.
 *
 * The source of truth is `packages/cli/skills/` (shipped in the `@lunora/cli`
 * tarball via the `files` allowlist). It is mirrored twice so agents working
 * inside this repo pick the skills up directly:
 *
 *     packages/cli/skills/<name>  <-  .agents/skills/<name>  <-  .claude/skills/<name>
 *
 * Both hops are symlinks, and both are tracked in git — which is exactly why
 * they rot invisibly. The `cirrus` -> `lunora` rename renamed the link NAMES
 * but not their TARGETS, leaving 11 of 14 skills dangling in both mirrors for
 * over a month: `git status` stays clean, nothing typechecks a symlink, and the
 * published tarball is unaffected, so no existing gate noticed.
 *
 * This guard fails on the four ways the mirrors drift:
 *
 * 1. A dangling link (the rename failure mode).
 * 2. A missing link — a skill was added to `packages/cli/skills/` but never
 *    mirrored (`lunora-setup-hyperdrive-global` shipped unmirrored this way).
 * 3. A real directory where a symlink belongs. This is the nastiest case: the
 *    copy keeps resolving, so agents load it happily while it drifts from the
 *    source. The mirrored `lunora-setup-hyperdrive` copies were a full minor
 *    version behind, teaching the dead `action({ args, handler })` object API
 *    long after the codebase moved to the chainable `action.input(...)` builder.
 * 4. A stale leftover — a skill deleted from the source whose mirrors survive.
 *    The source-driven checks above can't see these, so each mirror is also
 *    swept for links into its source area that no longer resolve to a skill.
 *    This caught two pre-existing casualties of the same rename,
 *    `.claude/skills/{migrate-to-vinext,vercel-react-best-practices}`.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

/** Source of truth — the directory published inside the `@lunora/cli` tarball. */
const sourceDir = join(rootDir, "packages", "cli", "skills");

/**
 * The mirror chain, in resolution order. Each entry links to the PREVIOUS
 * layer, not directly to the source: `.claude/skills` -> `.agents/skills` ->
 * `packages/cli/skills`. Keeping the hops relative means a worktree checkout
 * resolves without any absolute-path rewriting.
 */
const MIRRORS = [
    {
        dir: join(rootDir, ".agents", "skills"),
        // packages/cli/skills holds ONLY first-party skills, so any link into it
        // whose name has no source directory is stale by definition.
        staleWhenDangling: false,
        targetPrefix: "../../packages/cli/skills/",
    },
    {
        dir: join(rootDir, ".claude", "skills"),
        // .agents/skills also holds ~45 third-party skills (accessibility,
        // cloudflare, lunora-design, …) that .claude legitimately links to, so a
        // link into it is only stale once it DANGLES — otherwise we would fail on
        // every unrelated skill in the repo.
        staleWhenDangling: true,
        targetPrefix: "../../.agents/skills/",
    },
].map((mirror) => ({ ...mirror, expectedTarget: (name) => `${mirror.targetPrefix}${name}` }));

let hasFailure = false;

const fail = (message) => {
    hasFailure = true;
    console.error(`  ✖ ${message}`);
};

const skills = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

if (skills.length === 0) {
    console.error("check-skill-mirrors: no skills found in packages/cli/skills — is the checkout complete?");
    process.exit(1);
}

const skillNames = new Set(skills);

for (const { dir, expectedTarget, staleWhenDangling, targetPrefix } of MIRRORS) {
    const relativeDir = dir.slice(rootDir.length + 1);

    // Leftovers: a skill deleted from packages/cli/skills leaves its mirror
    // links behind, and the source-driven loop below would never look at them.
    // Only entries pointing into THIS mirror's source area are ours to judge —
    // see the staleWhenDangling notes on MIRRORS.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skillNames.has(entry.name) || !entry.isSymbolicLink()) {
            continue;
        }

        const linkPath = join(dir, entry.name);

        if (!readlinkSync(linkPath).startsWith(targetPrefix)) {
            continue;
        }

        if (!staleWhenDangling || !existsSync(linkPath)) {
            const source = targetPrefix.replace(/^(\.\.\/)+/, "").replace(/\/$/, "");

            fail(`${relativeDir}/${entry.name} points at ${source}/${entry.name}, which no longer exists — remove the stale mirror`);
        }
    }

    for (const name of skills) {
        const linkPath = join(dir, name);
        const want = expectedTarget(name);

        if (!existsSync(linkPath) && !isSymlink(linkPath)) {
            fail(`${relativeDir}/${name} is missing — add: ln -s ${want} ${relativeDir}/${name}`);
            continue;
        }

        if (!isSymlink(linkPath)) {
            fail(
                `${relativeDir}/${name} is a real directory, not a symlink — it will drift from packages/cli/skills/${name}. Replace it: rm -rf ${relativeDir}/${name} && ln -s ${want} ${relativeDir}/${name}`,
            );
            continue;
        }

        const actual = readlinkSync(linkPath);

        if (actual !== want) {
            fail(`${relativeDir}/${name} points at "${actual}", expected "${want}"`);
            continue;
        }

        if (!existsSync(linkPath)) {
            fail(`${relativeDir}/${name} is a dangling symlink -> ${actual}`);
        }
    }
}

/** `existsSync` follows symlinks, so a dangling link needs `lstat` to be seen at all. */
function isSymlink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

if (hasFailure) {
    console.error("\ncheck-skill-mirrors: the .agents/.claude skill mirrors are out of sync with packages/cli/skills.\n");
    process.exit(1);
}

console.log(`check-skill-mirrors: ${skills.length} skills mirrored correctly into .agents/skills and .claude/skills`);
