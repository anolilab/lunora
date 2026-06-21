/**
 * `vis generate lunora-step` — declare a reusable, schema-validated workflow
 * step in lunora/steps.ts.
 *
 * If steps.ts doesn't exist yet we write a fresh one. If it does, we append one
 * more `export const <name> = defineStep("<name>", {...})` declaration (exports
 * are order-independent, so a plain append is safe — unlike crons, no AST
 * surgery is needed). Steps are plain authoring helpers: they are NOT discovered
 * by codegen and need no wrangler/worker-entry wiring — import one into a
 * workflow body and run it with `context.runStep(step, args)`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";

const definitionFor = (exportName: string): string => `/**
 * A reusable durable step. Args are validated (\`@lunora/values\`) before the
 * handler runs and the return value is validated after (when \`returns\` is set).
 * Run it from a workflow body with \`context.runStep(${exportName}, args)\`.
 */
export const ${exportName} = defineStep("${exportName}", {
    // Argument validators — the handler receives the parsed, typed args.
    args: {
        // id: v.string(),
    },
    // Optional: validate the handler's return value.
    // returns: v.object({ ok: v.boolean() }),
    // Optional: per-step durability config (retries / timeout).
    // config: { retries: { limit: 3, backoff: "exponential", delay: "10 seconds" } },
    handler: async (context, args) => {
        // context.attempt: 1-based retry counter
        // context.run(api.<file>.<fn>, args): call a Lunora function
        // context.log / context.env / context.step ({ name, count })
        context.log.info("running ${exportName}", { args });

        return { ok: true };
    },
    // Optional compensation — runs if a *later* step fails after this one
    // committed (saga rollback). The context carries { args, error, output,
    // env, run, log }.
    // rollback: async (context) => {
    //     await context.run(api.<file>.<fn>, { id: context.args.id });
    // },
});
`;

const freshSteps = (exportName: string): string => `import { defineStep } from "@lunora/workflow";
import { v } from "@lunora/values";

import { api } from "./_generated/api";

${definitionFor(exportName)}`;

export default createTemplate({
    about: {
        description: "Declare a reusable workflow step in lunora/steps.ts (creates the file if missing)",
        name: "lunora-step",
    },
    options: {
        name: {
            prompt: "Step name (e.g. chargeOrder)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error("invalid step name: name must be a non-empty string");
        }

        const exportName = camelCase(raw);
        const stepsPath = join(builtins.dest_dir, "lunora", "steps.ts");

        const suggestions = [
            `Fill in the \`args\` validators and handler body for step "${exportName}".`,
            `Run it from a workflow with \`context.runStep(${exportName}, args)\`.`,
        ];

        if (!existsSync(stepsPath)) {
            return {
                files: { lunora: { "steps.ts": freshSteps(exportName) } },
                suggestions: [`Created lunora/steps.ts with step "${exportName}".`, ...suggestions],
            };
        }

        const original = readFileSync(stepsPath, "utf8");

        if (new RegExp(String.raw`\bexport\s+const\s+${exportName}\b`, "u").test(original)) {
            throw new Error(`step "${exportName}" already exists in ${stepsPath} — pick a different name.`);
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { lunora: { "steps.ts": `${original}${separator}${definitionFor(exportName)}` } },
            filesMeta: { "lunora/steps.ts": { force: true } },
            suggestions: [`Added step "${exportName}" to lunora/steps.ts.`, ...suggestions],
        };
    },
});
