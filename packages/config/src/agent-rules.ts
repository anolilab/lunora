import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-relative directory the Cirrus agent skills ("rules") install into.
 * This is the portable [Agent Skills](https://tanstack.com/intent/latest/docs/registry)
 * location — Cursor, Claude Code, and GitHub Copilot all discover skills here.
 */
const AGENT_RULES_DIR = ".agents/skills";

/**
 * The Cirrus agent skills shipped by `@cirrus/cli`. The first entry (`cirrus`)
 * is the router skill — its presence is what {@link detectAgentRules} treats as
 * "rules installed", since every other skill is reachable through it.
 */
const CIRRUS_SKILL_NAMES: ReadonlyArray<string> = [
    "cirrus",
    "cirrus-quickstart",
    "cirrus-functions",
    "cirrus-realtime",
    "cirrus-setup-auth",
    "cirrus-create-package",
    "cirrus-migration-helper",
    "cirrus-deploy",
    "cirrus-performance-audit",
];

/** The router skill whose presence marks the rule set as installed. */
const ROOT_SKILL_NAME = "cirrus";

interface AgentRulesStatus {
    /**
     * True when the `cirrus` router skill is installed. We key on the router
     * (not "all nine present") so a project that intentionally trims the set
     * still counts as installed and isn't nagged.
     */
    readonly installed: boolean;
    /** Skill names with no `SKILL.md` under `&lt;root>/.agents/skills/&lt;name>/`. */
    readonly missing: ReadonlyArray<string>;

    /** Skill names found under `&lt;root>/.agents/skills/&lt;name>/SKILL.md`. */
    readonly present: ReadonlyArray<string>;
}

/** Absolute path to a skill's `SKILL.md` under a project root. */
const skillFile = (projectRoot: string, name: string): string => join(projectRoot, AGENT_RULES_DIR, name, "SKILL.md");

/**
 * Detect whether the Cirrus agent skills are installed in `projectRoot` by
 * checking the skills folder for each `SKILL.md`. Pure filesystem reads, safe to
 * call on every dev-server / CLI startup — the CLI, the Vite plugin, and the
 * studio host all use it to decide whether to surface the "rules not installed"
 * hint.
 */
const detectAgentRules = (projectRoot: string): AgentRulesStatus => {
    const present: string[] = [];
    const missing: string[] = [];

    for (const name of CIRRUS_SKILL_NAMES) {
        if (existsSync(skillFile(projectRoot, name))) {
            present.push(name);
        } else {
            missing.push(name);
        }
    }

    return { installed: existsSync(skillFile(projectRoot, ROOT_SKILL_NAME)), missing, present };
};

export type { AgentRulesStatus };
export { AGENT_RULES_DIR, CIRRUS_SKILL_NAMES, detectAgentRules, ROOT_SKILL_NAME };
