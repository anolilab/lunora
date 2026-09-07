import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AGENT_RULES_DIR, detectAgentRules, LUNORA_SKILL_NAMES } from "@lunora/config";
import { dirname, join, relative, resolve } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { RulesOptions } from "./index";

interface RunRulesOptions {
    cwd?: string;
    /** Explicit install/check root, relative to `cwd`. Overrides workspace-root detection. */
    dir?: string;
    logger: Logger;
    /** Overwrite skill files that already exist in the project (default: skip them). */
    overwrite?: boolean;
    /** `check` only: exit non-zero when the rules are missing, so CI can gate on it. */
    strict?: boolean;
}

interface RunRulesResult {
    code: number;
    /** Skill names written this run (install). */
    installed: ReadonlyArray<string>;
    /** Skill names left untouched because they already existed (install, no `--overwrite`). */
    skipped: ReadonlyArray<string>;
}

/**
 * Resolve the `skills/` directory bundled with `@lunora/cli`. Walks up from
 * `startDirectory` (this module by default — works from both `dist/*.mjs` and
 * `src/`, and from the published `node_modules/@lunora/cli/dist/...` layout) to
 * the package root, then appends `skills`. Returns `undefined` when it can't be
 * located. `startDirectory` is injectable so the walk is unit-testable.
 */
const resolveBundledSkillsDirectory = (startDirectory: string = dirname(fileURLToPath(import.meta.url))): string | undefined => {
    let directory = startDirectory;

    for (let index = 0; index < 6; index += 1) {
        const packageJson = join(directory, "package.json");

        if (existsSync(packageJson)) {
            try {
                const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string };

                if (parsed.name === "@lunora/cli") {
                    const skills = join(directory, "skills");

                    return existsSync(skills) ? skills : undefined;
                }
            } catch {
                // keep walking
            }
        }

        const parent = dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    return undefined;
};

/** List the skill directories (those containing a `SKILL.md`) under the bundled `skills/` dir. */
const listBundledSkills = (skillsDirectory: string): string[] =>
    readdirSync(skillsDirectory).filter((name) => {
        const directory = join(skillsDirectory, name);

        return statSync(directory).isDirectory() && existsSync(join(directory, "SKILL.md"));
    });

/** Recursively copy a skill directory's files into the destination, returning whether any file was written. */
const copySkill = (source: string, destination: string, overwrite: boolean): boolean => {
    mkdirSync(destination, { recursive: true });

    let wrote = false;

    for (const entry of readdirSync(source)) {
        const from = join(source, entry);
        const to = join(destination, entry);

        if (statSync(from).isDirectory()) {
            wrote = copySkill(from, to, overwrite) || wrote;

            continue;
        }

        if (existsSync(to) && !overwrite) {
            continue;
        }

        writeFileSync(to, readFileSync(from));
        wrote = true;
    }

    return wrote;
};

/**
 * Markers that identify a workspace/repository root, in the order they are
 * trusted. A lockfile or a workspace manifest is a far stronger signal than a
 * `package.json` (every package in a monorepo has one of those).
 */
const WORKSPACE_ROOT_MARKERS = ["pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", ".git"];

/**
 * Walk up from `start` to the nearest workspace/repository root.
 *
 * Skills belong to the repo, not to whichever package you happened to `cd`
 * into: running `lunora rules install` from a subdirectory dropped them in
 * `<pkg>/.agents/skills`, where the coding agent never looks. Falls back to `start` when no marker is found, so a standalone project
 * behaves exactly as before.
 */
const resolveWorkspaceRoot = (start: string): string => {
    let directory = start;

    for (;;) {
        if (WORKSPACE_ROOT_MARKERS.some((marker) => existsSync(join(directory, marker)))) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return start;
        }

        directory = parent;
    }
};

/**
 * The directory `install` writes to and `check` reads from.
 *
 * Shared so the two cannot drift: if `check` resolved differently it would
 * report "missing" for skills `install` had just written one level up.
 */
const resolveRulesRoot = (invokedFrom: string, directory: string | undefined): string =>
    directory === undefined ? resolveWorkspaceRoot(invokedFrom) : resolve(invokedFrom, directory);

/**
 * `lunora rules install` — copy the bundled Lunora agent skills into the
 * project's `.agents/skills/`. Existing skill files are left untouched unless
 * `--overwrite` is set, so local edits survive a re-run.
 */
const runRulesInstall = (options: RunRulesOptions): RunRulesResult => {
    const invokedFrom = options.cwd ?? process.cwd();
    // `--dir` wins; otherwise install at the workspace root rather than wherever
    // the command was invoked from.
    const cwd = resolveRulesRoot(invokedFrom, options.dir);
    const overwrite = options.overwrite === true;
    const skillsDirectory = resolveBundledSkillsDirectory();

    if (skillsDirectory === undefined) {
        options.logger.error("rules: could not locate the bundled skills (is @lunora/cli installed correctly?).");

        return { code: 1, installed: [], skipped: [] };
    }

    const installed: string[] = [];
    const skipped: string[] = [];

    for (const name of listBundledSkills(skillsDirectory)) {
        const destination = join(cwd, AGENT_RULES_DIR, name);
        const wrote = copySkill(join(skillsDirectory, name), destination, overwrite);

        if (wrote) {
            installed.push(name);
        } else {
            skipped.push(name);
        }
    }

    // Relative to where the user actually is, so a workspace-root install from a
    // package subdirectory reads as `../../.agents/skills` rather than looking
    // like it landed next to them.
    const target = relative(invokedFrom, join(cwd, AGENT_RULES_DIR)) || AGENT_RULES_DIR;

    if (installed.length > 0) {
        options.logger.success(`Installed ${String(installed.length)} Lunora skill(s) into ${target}/: ${installed.join(", ")}.`);
    }

    if (skipped.length > 0) {
        options.logger.info(`Skipped ${String(skipped.length)} existing skill(s) (re-run with --overwrite to replace): ${skipped.join(", ")}.`);
    }

    options.logger.info("Your AI coding agent will pick these up automatically. Start with the `lunora` skill.");

    return { code: 0, installed, skipped };
};

/** `lunora rules check` — report which Lunora skills are installed in the project. */
const runRulesCheck = (options: RunRulesOptions): RunRulesResult => {
    const invokedFrom = options.cwd ?? process.cwd();
    // Must resolve the root exactly as `install` does, or `check` reports
    // "missing" for skills `install` just wrote one directory up.
    const cwd = resolveRulesRoot(invokedFrom, options.dir);
    const status = detectAgentRules(cwd);

    if (status.installed) {
        options.logger.success(`Lunora agent rules are installed (${String(status.present.length)}/${String(LUNORA_SKILL_NAMES.length)} skills).`);

        if (status.missing.length > 0) {
            options.logger.info(`Missing: ${status.missing.join(", ")}. Run \`lunora rules install\` to add them.`);
        }

        return { code: 0, installed: status.present, skipped: [] };
    }

    options.logger.warn("Lunora agent rules are not installed. Run `lunora rules install` so your AI agent knows how to use Lunora.");

    // `--strict` turns a missing rule set into a non-zero exit so CI can gate on it.
    return { code: options.strict === true ? 1 : 0, installed: status.present, skipped: [] };
};

/** `lunora rules <install|check>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<RulesOptions> = defineHandler<RulesOptions>(({ argument, cwd, logger, options }) => {
    const subcommand = argument[0] ?? "check";

    if (subcommand === "install") {
        return runRulesInstall({ cwd, dir: options.dir, logger, overwrite: options.overwrite === true });
    }

    if (subcommand === "check") {
        return runRulesCheck({ cwd, dir: options.dir, logger, strict: options.strict === true });
    }

    logger.error("rules: unknown subcommand. Usage: lunora rules <install|check>");

    return { code: 1 };
});

export { execute, listBundledSkills, resolveBundledSkillsDirectory, runRulesCheck, runRulesInstall };
export type { RunRulesOptions, RunRulesResult };
