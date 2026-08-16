import type { SkillDefinition } from "@lunora/agent";
// The markdown compiler is a subpath export: it pulls in a YAML parser, which
// the agent root deliberately keeps out of every Worker that imports it.
import { skillFromMarkdown } from "@lunora/agent/skill-markdown";

import { SKILL_SOURCES } from "./skills.generated";

/**
 * The builder agent's knowledge, compiled from the framework's own skill corpus
 * (plan 335 §D4 and W4).
 *
 * `skillFromMarkdown` already does the whole compile — frontmatter split, real
 * YAML parse, `SkillDefinition` out — so this file is selection and budgeting,
 * not parsing. That is the point of D4: the corpus in `packages/cli/skills` is
 * the single source of truth, and a second hand-written prompt corpus would
 * drift from the docs the moment either changed.
 */

/** Ceiling on the instruction text one turn may carry, in characters. */
const INSTRUCTION_BUDGET = 120_000;

/** Every selected skill, compiled. */
const ALL_SKILLS: ReadonlyArray<{ always: boolean; skill: SkillDefinition; triggers: ReadonlyArray<string> }> = SKILL_SOURCES.map((source) => {
    return {
        always: source.always,
        // No `name` override: `SkillMarkdownExtras` omits it because the name is the
        // skill's own frontmatter `name:` field, which is the value the corpus
        // maintains and the one an eval failure should point at.
        skill: skillFromMarkdown(source.markdown),
        triggers: source.triggers,
    };
});

/**
 * The skills handed to `defineAgent`.
 *
 * All of them: `defineAgent` merges instructions once at declaration time, and
 * per-turn selection would mean rebuilding the agent per request — which the
 * durable-workflow compile makes the wrong shape entirely. `selectSkills` below
 * exists for the narrower job of deciding what a *prompt* is about, which the
 * evals use and which a future router can use to trim the budget.
 */
const builderSkills: ReadonlyArray<SkillDefinition> = ALL_SKILLS.map((entry) => entry.skill);

/**
 * Which skills a prompt is actually about.
 *
 * Deliberately a keyword match rather than an embedding lookup: it is
 * inspectable, it costs nothing, and when an eval shows it picking wrong the fix
 * is a word in a list rather than a retrained index. Plan 335 leaves the
 * mechanism open; this is the cheapest one that can be corrected.
 */
const selectSkills = (prompt: string): ReadonlyArray<string> => {
    const haystack = prompt.toLowerCase();

    return ALL_SKILLS.filter((entry) => entry.always || entry.triggers.some((trigger) => haystack.includes(trigger))).map((entry) => entry.skill.name);
};

/** Total instruction characters across every selected skill — what the budget test asserts against. */
const instructionSize = (): number => SKILL_SOURCES.reduce((sum, source) => sum + source.markdown.length, 0);

/**
 * The agent's own instructions, which sit *above* the skills.
 *
 * Short on purpose. Everything about how to write Lunora code belongs in the
 * skills, where the framework maintains it; what belongs here is only what is
 * true of this agent and no other — its loop, its tools, and the two failure
 * modes that waste a whole build when the model gets them wrong.
 */
const BUILDER_INSTRUCTIONS = [
    "You build Lunora applications for a user who is watching. Lunora is a type-safe, real-time backend on Cloudflare Workers and Durable Objects.",
    "",
    "How to work:",
    "- Call `ls` before anything else. Never guess a path.",
    "- Call `view` before `edit`. An edit against a stale copy fails, and re-reading is cheaper than a failed turn.",
    "- Prefer `edit` over `write` for an existing file: it is cheaper and leaves a diff the user can review.",
    "- Call `verify` after a set of related changes and fix what it reports. A non-zero exit means the project is broken — do not report success over it.",
    "- Make the smallest change that satisfies the request, then stop. Do not refactor code the user did not ask about.",
    "",
    "Two things that waste a build:",
    "- Writing `lunora/_generated/*` by hand. It is codegen output; change the schema instead.",
    "- Inventing an API. If you are unsure a function exists, read the file or say so — a plausible wrong import costs a whole verify cycle.",
].join("\n");

export { BUILDER_INSTRUCTIONS, builderSkills, INSTRUCTION_BUDGET, instructionSize, selectSkills };

export { type SkillDefinition } from "@lunora/agent";
