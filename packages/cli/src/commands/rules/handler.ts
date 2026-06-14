import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AGENT_RULES_DIR, CIRRUS_SKILL_NAMES, detectAgentRules } from "@cirrus/config";
import { dirname, join, relative } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { RulesOptions } from "./index";

interface RunRulesOptions {
    cwd?: string;
    logger: Logger;
    /** Overwrite skill files that already exist in the project (default: skip them). */
    overwrite?: boolean;
}

interface RunRulesResult {
    code: number;
    /** Skill names written this run (install). */
    installed: ReadonlyArray<string>;
    /** Skill names left untouched because they already existed (install, no `--overwrite`). */
    skipped: ReadonlyArray<string>;
}

/**
 * Resolve the `skills/` directory bundled with `@cirrus/cli`. Walks up from this
 * module (works from both `dist/*.mjs` and `src/`) to the package root, then
 * appends `skills`. Returns `undefined` when it can't be located.
 */
const resolveBundledSkillsDirectory = (): string | undefined => {
    let directory = dirname(fileURLToPath(import.meta.url));

    for (let index = 0; index < 6; index += 1) {
        const packageJson = join(directory, "package.json");

        if (existsSync(packageJson)) {
            try {
                const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string };

                if (parsed.name === "@cirrus/cli") {
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
 * `cirrus rules install` — copy the bundled Cirrus agent skills into the
 * project's `.agents/skills/`. Existing skill files are left untouched unless
 * `--overwrite` is set, so local edits survive a re-run.
 */
const runRulesInstall = (options: RunRulesOptions): RunRulesResult => {
    const cwd = options.cwd ?? process.cwd();
    const overwrite = options.overwrite === true;
    const skillsDirectory = resolveBundledSkillsDirectory();

    if (skillsDirectory === undefined) {
        options.logger.error("rules: could not locate the bundled skills (is @cirrus/cli installed correctly?).");

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

    const target = relative(cwd, join(cwd, AGENT_RULES_DIR)) || AGENT_RULES_DIR;

    if (installed.length > 0) {
        options.logger.success(`Installed ${String(installed.length)} Cirrus skill(s) into ${target}/: ${installed.join(", ")}.`);
    }

    if (skipped.length > 0) {
        options.logger.info(`Skipped ${String(skipped.length)} existing skill(s) (re-run with --overwrite to replace): ${skipped.join(", ")}.`);
    }

    options.logger.info("Your AI coding agent will pick these up automatically. Start with the `cirrus` skill.");

    return { code: 0, installed, skipped };
};

/** `cirrus rules check` — report which Cirrus skills are installed in the project. */
const runRulesCheck = (options: RunRulesOptions): RunRulesResult => {
    const cwd = options.cwd ?? process.cwd();
    const status = detectAgentRules(cwd);

    if (status.installed) {
        options.logger.success(`Cirrus agent rules are installed (${String(status.present.length)}/${String(CIRRUS_SKILL_NAMES.length)} skills).`);

        if (status.missing.length > 0) {
            options.logger.info(`Missing: ${status.missing.join(", ")}. Run \`cirrus rules install\` to add them.`);
        }
    } else {
        options.logger.warn("Cirrus agent rules are not installed. Run `cirrus rules install` so your AI agent knows how to use Cirrus.");
    }

    return { code: 0, installed: status.present, skipped: [] };
};

/** `cirrus rules &lt;install|check>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<RulesOptions> = defineHandler<RulesOptions>(({ argument, cwd, logger, options }) => {
    const subcommand = argument[0] ?? "check";

    if (subcommand === "install") {
        return runRulesInstall({ cwd, logger, overwrite: options.overwrite === true });
    }

    if (subcommand === "check") {
        return runRulesCheck({ cwd, logger });
    }

    logger.error("rules: unknown subcommand. Usage: cirrus rules <install|check>");

    return { code: 1 };
});

export { execute, runRulesCheck, runRulesInstall };
export type { RunRulesOptions, RunRulesResult };
