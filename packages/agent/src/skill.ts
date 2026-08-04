import { LunoraError } from "@lunora/errors";
import { parse as parseYaml } from "yaml";

import type { SkillConfig, SkillDefinition, SkillMarkdownExtras } from "./types";

/** Skill names namespace a skill's knowledge memory source — keep them identifier-shaped. */
const SKILL_NAME_PATTERN: RegExp = /^[a-zA-Z][\w-]*$/u;

/**
 * Reserved skill name. `"default"` is the internal key `defineAgent` gives the
 * agent's own `memory` source, and it maps to the historic `"memory:retrieve"`
 * durable step. A skill named `"default"` would collide with that step, so the
 * name is reserved and rejected at declaration time.
 */
const RESERVED_SKILL_NAME = "default";

/**
 * The frontmatter delimiter line, at the very start of the document.
 * Leading whitespace and a BOM are tolerated; anything else is not frontmatter.
 */
const FRONTMATTER_OPEN = /^\s*---[ \t]*\r?\n/u;

/** The closing delimiter, alone on its line. */
const FRONTMATTER_CLOSE = /^---[ \t]*$/mu;

/**
 * Split a `SKILL.md` into its frontmatter and its instruction body.
 *
 * The block is parsed as real YAML rather than scanned for the one key this
 * reads, so a skill file stays a normal skill file: the `description`, license
 * and tool allow-lists other tooling puts there parse rather than confuse the
 * reader, and a `name` written in any valid form is found.
 *
 * A malformed block throws instead of degrading to "no frontmatter" — silently
 * treating it as body text would report a missing `name` for a file whose real
 * problem is a YAML syntax error, sending the author to the wrong line.
 */
const splitFrontmatter = (markdown: string): { body: string; data: Record<string, unknown> } => {
    const open = FRONTMATTER_OPEN.exec(markdown);

    if (!open) {
        return { body: markdown.trim(), data: {} };
    }

    const rest = markdown.slice(open[0].length);
    const close = FRONTMATTER_CLOSE.exec(rest);

    if (!close) {
        return { body: markdown.trim(), data: {} };
    }

    let data: unknown;

    try {
        data = parseYaml(rest.slice(0, close.index));
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: the skill markdown has invalid YAML frontmatter — ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return {
        body: rest.slice(close.index + close[0].length).trim(),
        // A frontmatter block of only comments parses to null, not an object.
        data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
    };
};

/**
 * Declare a reusable skill: a bundle of expertise — an instruction fragment,
 * tools, and retrieval `knowledge` — an agent composes in via
 * `defineAgent({ skills: [...] })`. Reuse-first: a skill's `tools` carry the
 * SAME `AnyAgentTool` shape agents already use (`functionTool` / `mcpTools` /
 * `agentAsTool`), and `knowledge` reuses `memory`'s `AgentMemoryOptions`
 * retrieval verbatim.
 *
 * ```ts
 * import { defineSkill, functionTool } from "@lunora/agent";
 *
 * export const billing = defineSkill({
 *     name: "billing",
 *     instructions: "When asked about invoices, cite the invoice id.",
 *     knowledge: { source: "rag:searchBillingDocs", topK: 4 },
 *     tools: {
 *         lookupInvoice: functionTool(api.billing.invoiceById, {
 *             description: "Look up an invoice by id.",
 *             inputSchema: jsonSchema({ properties: { id: { type: "string" } }, required: ["id"], type: "object" }),
 *         }),
 *     },
 * });
 * ```
 *
 * The merge into the agent's flat namespace (tool-name collisions, instruction
 * ordering, per-skill knowledge retrieval) happens in `defineAgent` — a skill
 * only validates its own `name`; tool-name validation is deferred to the merge,
 * which owns the flat model-facing namespace.
 * @experimental
 */
const defineSkill = (config: SkillConfig): SkillDefinition => {
    // The type forbids it, but a plain-JS caller can still omit/misname `name` —
    // fail at declaration time, not at the merge into an agent.
    if (typeof config.name !== "string" || !SKILL_NAME_PATTERN.test(config.name)) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: defineSkill requires a \`name\` that is a valid identifier (letters, digits, _ or -, starting with a letter), got ${JSON.stringify(config.name)}`,
        );
    }

    if (config.name === RESERVED_SKILL_NAME) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: skill name "${RESERVED_SKILL_NAME}" is reserved (it keys the agent's own \`memory\` source / the historic \`memory:retrieve\` step) — choose another name`,
        );
    }

    return { ...config, isLunoraSkill: true };
};

/**
 * Declare a skill whose prose lives in a markdown file.
 *
 * ```ts
 * import triage from "./skills/triage/SKILL.md?raw";
 * import { functionTool, skillFromMarkdown } from "@lunora/agent";
 *
 * export const triageSkill = skillFromMarkdown(triage, {
 *     tools: { searchCode: functionTool(api.code.search, { ... }) },
 * });
 * ```
 *
 * ```md
 * ---
 * name: triage
 * ---
 * Reproduce the report before proposing a cause. Cite the failing test.
 * ```
 *
 * The split is the point: the instructions are the part a non-author reads,
 * reviews and copies between projects, so they belong in a file that is legible
 * on its own — and the `name` travels WITH that file, so a skill can move
 * without a matching TypeScript wrapper. Tools and `knowledge` stay in code,
 * because they are code.
 *
 * Getting the markdown here is the caller's job (`?raw` under Vite, a build-time
 * import elsewhere) — a Worker has no filesystem to read it from at runtime, so
 * this takes the string rather than a path.
 * @experimental
 */
const skillFromMarkdown = (markdown: string, extras: SkillMarkdownExtras = {}): SkillDefinition => {
    if (typeof markdown !== "string") {
        throw new LunoraError("INTERNAL", `@lunora/agent: skillFromMarkdown expects the markdown SOURCE as a string, got ${typeof markdown}`);
    }

    const { body, data } = splitFrontmatter(markdown);

    if (typeof data.name !== "string") {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/agent: skillFromMarkdown found no `name` in the markdown frontmatter. " +
                "Open the file with a `---` line, put `name: <identifier>` on its own line, and close it with `---`. " +
                "Other keys are parsed and ignored — only `name` is read here.",
        );
    }

    // `defineSkill` owns the shape check: an identifier-shaped, non-reserved
    // name, with the same message whichever way the skill was authored.
    return defineSkill({ ...extras, instructions: body, name: data.name });
};

/**
 * Runtime brand check for a {@link SkillDefinition}.
 * @experimental
 */
const isSkillDefinition = (value: unknown): value is SkillDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraSkill?: unknown }).isLunoraSkill === true;

export type { SkillConfig, SkillDefinition, SkillMarkdownExtras } from "./types";
export { defineSkill, isSkillDefinition, RESERVED_SKILL_NAME, SKILL_NAME_PATTERN, skillFromMarkdown };
