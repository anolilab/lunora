import { defineAgent, defineAgentTool } from "@lunora/agent";
import { jsonSchema } from "@lunora/ai";

import { api, internal } from "#lunora/_generated/api.js";

import { BUILDER_INSTRUCTIONS, builderSkills } from "./skills";

/**
 * The model the build loop runs on.
 *
 * A Workers AI id keeps the app runnable with only the `AI` binding — no
 * provider key, no gateway setup — which is what makes a first run possible for
 * someone who just cloned this. Plan 335 §D9 routes Anthropic/OpenAI/Google
 * through AI Gateway with BYOK; swapping this for an `(env) => model` thunk is
 * the whole of that change.
 */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Bound on one build request, so a loop that stops converging stops costing. */
const MAX_TURNS = 24;

/** A `projectId` argument, repeated on every tool — the shard key each one routes by. */
const PROJECT_ID = { description: "The project this call belongs to.", type: "string" } as const;

/**
 * The build agent — plan 335 W3.
 *
 * Every tool dispatches a Lunora function rather than touching storage itself:
 * the loop runs inside a durable workflow step with no `ctx.db`, and routing
 * through `run` is what makes each call replay-safe. The result is that the
 * tools are thin, and the rules they enforce (path safety, the command
 * allowlist, the exactly-one-match edit) live in the functions where they can be
 * tested without a model.
 */
export const builder = defineAgent({
    instructions: BUILDER_INSTRUCTIONS,
    maxTurns: MAX_TURNS,
    model: MODEL,
    skills: builderSkills,
    tools: {
        edit: defineAgentTool({
            description:
                "Replace an exact snippet in a file. `find` must match exactly once — include surrounding lines until it does. Prefer this over `write` for changing an existing file.",
            execute: async ({ find, path, projectId, replace }, { run }) => run(internal.files.editInternal, { find, path, projectId, replace }),
            inputSchema: jsonSchema({
                properties: {
                    find: { description: "The exact text to replace, including enough context to be unique.", type: "string" },
                    path: { description: "Project-relative path.", type: "string" },
                    projectId: PROJECT_ID,
                    replace: { description: "What to put in its place.", type: "string" },
                },
                required: ["projectId", "path", "find", "replace"],
                type: "object",
            }),
        }),

        exec: defineAgentTool({
            description:
                "Run one command in the project sandbox. There is no shell: pass the program and its arguments separately. Allowed: git, lunora, node, pnpm, wrangler.",
            // Gated: a command runs code on the project's behalf, and the model
            // chose it. The FS tools are unattended because their blast radius
            // is one project's files; this one's is a process.
            execute: async ({ args, command, projectId }, { run }) => run(api.commands.run, { args, command, projectId }),
            inputSchema: jsonSchema({
                properties: {
                    args: { description: "Arguments, one per element.", items: { type: "string" }, type: "array" },
                    command: { description: "The program to run.", type: "string" },
                    projectId: PROJECT_ID,
                },
                required: ["projectId", "command"],
                type: "object",
            }),
            needsApproval: true,
        }),

        ls: defineAgentTool({
            description: "List every file in the project. Call this first — do not guess at paths.",
            execute: async ({ projectId }, { run }) => run(internal.files.listInternal, { projectId }),
            inputSchema: jsonSchema({ properties: { projectId: PROJECT_ID }, required: ["projectId"], type: "object" }),
        }),

        verify: defineAgentTool({
            description:
                "Check the project: wrangler config, codegen and types. Run it after a change and fix what it reports. A non-zero code means the project is broken.",
            execute: async ({ projectId }, { run }) => run(api.commands.run, { args: ["verify", "--format", "json"], command: "lunora", projectId }),
            inputSchema: jsonSchema({ properties: { projectId: PROJECT_ID }, required: ["projectId"], type: "object" }),
        }),

        view: defineAgentTool({
            description: "Read one file. Always read before editing — an edit against a stale copy fails.",
            execute: async ({ path, projectId }, { run }) => run(internal.files.readInternal, { path, projectId }),
            inputSchema: jsonSchema({
                properties: { path: { description: "Project-relative path.", type: "string" }, projectId: PROJECT_ID },
                required: ["projectId", "path"],
                type: "object",
            }),
        }),

        write: defineAgentTool({
            description: "Create a file, or replace one entirely. For a change to an existing file prefer `edit` — it is cheaper and leaves a reviewable diff.",
            execute: async ({ content, path, projectId }, { run }) => run(internal.files.writeInternal, { content, path, projectId }),
            inputSchema: jsonSchema({
                properties: {
                    content: { description: "The complete file contents.", type: "string" },
                    path: { description: "Project-relative path.", type: "string" },
                    projectId: PROJECT_ID,
                },
                required: ["projectId", "path", "content"],
                type: "object",
            }),
        }),
    },
});
