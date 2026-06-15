/**
 * `vis generate lunora-workflow` — declare a Cloudflare Workflow in
 * lunora/workflows.ts.
 *
 * If workflows.ts doesn't exist yet we write a fresh one. If it does, we append
 * one more `export const <name> = defineWorkflow({...})` declaration (exports
 * are order-independent, so a plain append is safe — unlike crons, no AST
 * surgery is needed). Codegen discovers each export and emits the
 * WorkflowEntrypoint class; `lunora dev`/`lunora deploy` reconcile the wrangler
 * `workflows[]` entry. Workflows are NOT Durable Objects — no migration entry.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";
import { nestFile, wireWorkerEntryReexport, WORKFLOWS_TARGET } from "./_helpers/wire-worker-entry.js";

const definitionFor = (exportName: string): string => `/**
 * One durable workflow. Codegen wires \`ctx.workflows.get("${exportName}")\` onto
 * mutations/actions — start an instance with
 * \`ctx.workflows.get("${exportName}").create({ params })\`.
 */
export const ${exportName} = defineWorkflow({
    handler: async (context) => {
        // Each \`context.step.do(...)\` is a durable, memoized, retried step.
        await context.step.do("first-step", async () => {
            context.log.info("running ${exportName}");
        });

        // Durable sleep — the workflow hibernates here and resumes after the
        // delay, surviving Worker evictions and redeploys.
        await context.step.sleep("settle", "1 minute");

        // Call a Lunora function on a shard from inside the workflow:
        //   await context.run(api.<file>.<fn>, args, { shardKey });
    },
});
`;

const freshWorkflows = (exportName: string): string => `import { defineWorkflow } from "@lunora/workflow";

${definitionFor(exportName)}`;

export default createTemplate({
    about: {
        description: "Declare a workflow in lunora/workflows.ts (creates the file if missing)",
        name: "lunora-workflow",
    },
    options: {
        name: {
            prompt: "Workflow name (e.g. orderPipeline)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error("invalid workflow name: name must be a non-empty string");
        }

        const exportName = camelCase(raw);
        const workflowsPath = join(builtins.dest_dir, "lunora", "workflows.ts");

        // Auto-wire the worker-entry re-export for class-B/C (class-A is handled
        // by the Vite plugin). When found, fold the rewritten entry into `files`
        // + `filesMeta`; otherwise fall back to a printed instruction.
        const entry = wireWorkerEntryReexport(builtins.dest_dir, WORKFLOWS_TARGET);
        const entryFiles = entry ? nestFile(entry.relativePath, entry.content) : {};
        const entryMeta = entry ? { [entry.relativePath]: { force: true } } : {};
        const entrySuggestion = entry
            ? `Re-exported the generated workflow classes from ${entry.relativePath}.`
            : 'Re-export the generated classes from your worker entry: `export * from "./lunora/_generated/workflows"`.';

        const suggestions = [entrySuggestion, "Run `lunora codegen` (or just `lunora dev`) to emit the WorkflowEntrypoint class and reconcile wrangler.jsonc."];

        if (!existsSync(workflowsPath)) {
            return {
                files: { ...entryFiles, lunora: { "workflows.ts": freshWorkflows(exportName) } },
                filesMeta: entryMeta,
                suggestions: [`Created lunora/workflows.ts with workflow "${exportName}".`, ...suggestions],
            };
        }

        const original = readFileSync(workflowsPath, "utf8");

        if (new RegExp(String.raw`\bexport\s+const\s+${exportName}\b`, "u").test(original)) {
            throw new Error(`workflow "${exportName}" already exists in ${workflowsPath} — pick a different name.`);
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { ...entryFiles, lunora: { "workflows.ts": `${original}${separator}${definitionFor(exportName)}` } },
            filesMeta: { "lunora/workflows.ts": { force: true }, ...entryMeta },
            suggestions: [`Added workflow "${exportName}" to lunora/workflows.ts.`, ...suggestions],
        };
    },
});
