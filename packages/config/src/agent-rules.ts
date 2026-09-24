import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-relative directory the Lunora agent skills ("rules") install into.
 * This is the portable [Agent Skills](https://tanstack.com/intent/latest/docs/registry)
 * location — Cursor, Claude Code, and GitHub Copilot all discover skills here.
 */
const AGENT_RULES_DIR = ".agents/skills";

/** Env var the once-per-process-tree hint guard ({@link claimAgentRulesHint}) sets. */
const AGENT_RULES_HINT_ENV = "LUNORA_RULES_HINT_SHOWN";

/**
 * The Lunora agent skills shipped by `@lunora/cli`. The first entry (`lunora`)
 * is the router skill — its presence is what {@link detectAgentRules} treats as
 * "rules installed", since every other skill is reachable through it.
 *
 * `lunora rules install` enumerates `@lunora/cli`'s `skills/` directory rather
 * than reading this list, so a skill missing here still installs — but
 * `lunora rules check` counts against it, and reported "9/9 skills" with an
 * empty "Missing:" line for a project holding all 14. The CLI's rules test
 * pins the two together, since this package cannot see that directory.
 */
const LUNORA_SKILL_NAMES: ReadonlyArray<string> = [
    "lunora",
    "lunora-quickstart",
    "lunora-functions",
    "lunora-realtime",
    "lunora-setup-auth",
    "lunora-setup-hyperdrive",
    "lunora-setup-hyperdrive-global",
    "lunora-setup-mail",
    "lunora-setup-scheduler",
    "lunora-setup-storage",
    "lunora-create-package",
    "lunora-migration-helper",
    "lunora-deploy",
    "lunora-performance-audit",
];

/** The router skill whose presence marks the rule set as installed. */
const ROOT_SKILL_NAME = "lunora";

/**
 * The single "rules not installed" message shared by every surface (the CLI
 * `lunora dev` summary and the Vite dev plugin), so the wording and the
 * pointer at `lunora rules install` stay identical wherever it appears.
 */
const AGENT_RULES_HINT = "Lunora AI rules not installed — run `lunora rules install` so your coding agent knows how to use Lunora.";

/**
 * Process-tree guard so the hint is emitted at most once. The first surface to
 * print it sets {@link AGENT_RULES_HINT_ENV} on `process.env`; later surfaces (a
 * Vite dev-server restart, or a child process that inherited the env) read it
 * and stay quiet. Returns `true` the first time, `false` afterwards.
 */
const claimAgentRulesHint = (): boolean => {
    if (process.env[AGENT_RULES_HINT_ENV] === "1") {
        return false;
    }

    process.env[AGENT_RULES_HINT_ENV] = "1";

    return true;
};

interface AgentRulesStatus {
    /**
     * True when the `lunora` router skill is installed. We key on the router
     * (not "all nine present") so a project that intentionally trims the set
     * still counts as installed and isn't nagged.
     */
    readonly installed: boolean;
    /** Skill names with no `SKILL.md` under `<root>/.agents/skills/<name>/`. */
    readonly missing: ReadonlyArray<string>;

    /** Skill names found under `<root>/.agents/skills/<name>/SKILL.md`. */
    readonly present: ReadonlyArray<string>;
}

/** Absolute path to a skill's `SKILL.md` under a project root. */
const skillFile = (projectRoot: string, name: string): string => join(projectRoot, AGENT_RULES_DIR, name, "SKILL.md");

/**
 * Detect whether the Lunora agent skills are installed in `projectRoot` by
 * checking the skills folder for each `SKILL.md`. Pure filesystem reads, safe to
 * call on every dev-server / CLI startup — the CLI, the Vite plugin, and the
 * studio host all use it to decide whether to surface the "rules not installed"
 * hint.
 */
const detectAgentRules = (projectRoot: string): AgentRulesStatus => {
    const present: string[] = [];
    const missing: string[] = [];

    for (const name of LUNORA_SKILL_NAMES) {
        if (existsSync(skillFile(projectRoot, name))) {
            present.push(name);
        } else {
            missing.push(name);
        }
    }

    return { installed: existsSync(skillFile(projectRoot, ROOT_SKILL_NAME)), missing, present };
};

export type { AgentRulesStatus };
export { AGENT_RULES_DIR, AGENT_RULES_HINT, AGENT_RULES_HINT_ENV, claimAgentRulesHint, detectAgentRules, LUNORA_SKILL_NAMES, ROOT_SKILL_NAME };
