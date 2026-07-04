/**
 * `vis generate lunora-agent` — declare a durable AI agent in lunora/agents.ts.
 *
 * If agents.ts doesn't exist yet we write a fresh one. If it does, we append one
 * more `export const <name> = defineAgent({...})` declaration (exports are
 * order-independent, so a plain append is safe — no AST surgery needed). Codegen
 * discovers each export, auto-registers the `agents:*` runtime functions + the
 * public thread queries, wires the typed `ctx.agents.<name>` producer, and emits
 * the agent's WorkflowEntrypoint class — an agent run IS a Cloudflare Workflow
 * instance, so `lunora dev`/`lunora deploy` reconcile the wrangler `workflows[]`
 * entry. Like a workflow, the generated class must be re-exported by the worker
 * entry (auto-wired below for class-B/C), and the thread tables must be merged
 * into the schema with `.extend(agentExtension)`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";
import { AGENTS_TARGET, nestFile, wireWorkerEntryReexport } from "./_helpers/wire-worker-entry.js";

const definitionFor = (exportName: string): string => `/**
 * One durable AI agent. Codegen wires \`ctx.agents.${exportName}\` onto
 * mutations/actions — start (or continue) a run with
 * \`await ctx.agents.${exportName}.run({ input, threadKey })\` and subscribe to
 * \`api.agents.agentMessages\` to stream the conversation. Each LLM turn and each
 * tool call is a named durable step, so a crashed run resumes without re-paying
 * for a model call or re-charging a card.
 */
export const ${exportName} = defineAgent({
    instructions: "You are a helpful assistant.",
    // Cost/step cap: maximum LLM turns per run. Composes with \`stopWhen\`.
    maxTurns: 8,
    // A Workers AI id, a prebuilt AI SDK model, or \`(env) => model\`.
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tools: {
        // Add tools with \`defineAgentTool\` — the loop runs each inside its own
        // durable step (the step name is the tool's idempotency key):
        //
        // getWeather: defineAgentTool({
        //     description: "Look up the current weather for a city.",
        //     execute: async ({ city }, { idempotencyKey, run, threadKey }) => run(api.weather.lookup, { city }),
        //     inputSchema: jsonSchema({ properties: { city: { type: "string" } }, required: ["city"], type: "object" }),
        // }),
    },
});
`;

const freshAgents = (exportName: string): string => `import { defineAgent } from "@lunora/agent";

${definitionFor(exportName)}`;

export default createTemplate({
    about: {
        description: "Declare a durable AI agent in lunora/agents.ts (creates the file if missing)",
        name: "lunora-agent",
    },
    options: {
        name: {
            prompt: "Agent name (e.g. support)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error("invalid agent name: name must be a non-empty string");
        }

        const exportName = camelCase(raw);
        const agentsPath = join(builtins.dest_dir, "lunora", "agents.ts");

        // Auto-wire the worker-entry re-export for class-B/C (class-A is handled
        // by the Vite plugin). When found, fold the rewritten entry into `files`
        // + `filesMeta`; otherwise fall back to a printed instruction.
        const entry = wireWorkerEntryReexport(builtins.dest_dir, AGENTS_TARGET);
        const entryFiles = entry ? nestFile(entry.relativePath, entry.content) : {};
        const entryMeta = entry ? { [entry.relativePath]: { force: true } } : {};
        const entrySuggestion = entry
            ? `Re-exported the generated agent classes from ${entry.relativePath}.`
            : 'Re-export the generated classes from your worker entry: `export * from "./lunora/_generated/agents"`.';

        const suggestions = [
            entrySuggestion,
            "Merge the agent thread tables into your schema: `defineSchema({...}).extend(agentExtension)` (from `@lunora/agent`).",
            "Run `lunora codegen` (or just `lunora dev`) to emit the agent WorkflowEntrypoint class + `ctx.agents` producer and reconcile wrangler.jsonc.",
        ];

        if (!existsSync(agentsPath)) {
            return {
                files: { ...entryFiles, lunora: { "agents.ts": freshAgents(exportName) } },
                filesMeta: entryMeta,
                suggestions: [`Created lunora/agents.ts with agent "${exportName}".`, ...suggestions],
            };
        }

        const original = readFileSync(agentsPath, "utf8");

        if (new RegExp(String.raw`\bexport\s+const\s+${exportName}\b`, "u").test(original)) {
            throw new Error(`agent "${exportName}" already exists in ${agentsPath} — pick a different name.`);
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { ...entryFiles, lunora: { "agents.ts": `${original}${separator}${definitionFor(exportName)}` } },
            filesMeta: { "lunora/agents.ts": { force: true }, ...entryMeta },
            suggestions: [`Added agent "${exportName}" to lunora/agents.ts.`, ...suggestions],
        };
    },
});
