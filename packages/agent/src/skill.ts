import { LunoraError } from "@lunora/errors";

import type { SkillConfig, SkillDefinition } from "./types";

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
 * Runtime brand check for a {@link SkillDefinition}.
 * @experimental
 */
const isSkillDefinition = (value: unknown): value is SkillDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraSkill?: unknown }).isLunoraSkill === true;

export type { SkillConfig, SkillDefinition } from "./types";
export { defineSkill, isSkillDefinition, RESERVED_SKILL_NAME, SKILL_NAME_PATTERN };
