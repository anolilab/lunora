/**
 * `vis generate lunora-queue` — declare a Cloudflare Queue in lunora/queues.ts.
 *
 * If queues.ts doesn't exist yet we write a fresh one. If it does, we append one
 * more `export const <name> = defineQueue({...})` declaration (exports are
 * order-independent, so a plain append is safe — no AST surgery needed). Codegen
 * discovers each export, emits the typed `ctx.queues` producer + the worker
 * `queue()` dispatch, and `lunora dev`/`lunora deploy` reconcile the wrangler
 * `queues.producers[]` / `queues.consumers[]` entries. Unlike workflows, a queue
 * needs no worker-entry class re-export — its consumer handler rides
 * `createWorker`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";

const definitionFor = (exportName: string): string => `/**
 * One Cloudflare Queue. Codegen wires \`ctx.queues.${exportName}\` onto
 * mutations/actions — enqueue with
 * \`await ctx.queues.${exportName}.send(message)\`. The handler below processes
 * each delivered batch (push consumer); to touch data, call a Lunora function
 * with \`await context.run(api.<file>.<fn>, args)\`.
 */
export const ${exportName} = defineQueue({
    handler: async (context, batch) => {
        for (const message of batch.messages) {
            try {
                context.log.info("processing", message.id);
                // await context.run(api.<file>.<fn>, message.body);
                message.ack();
            } catch (error) {
                context.log.error("failed", message.id, error);
                message.retry();
            }
        }
    },
    // Push-consumer tuning (optional):
    // maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: "dlq",
    // Or expose the queue to an external HTTP pull consumer instead:
    // mode: "pull",
});
`;

const freshQueues = (exportName: string): string => `import { defineQueue } from "@lunora/queue";

${definitionFor(exportName)}`;

export default createTemplate({
    about: {
        description: "Declare a queue in lunora/queues.ts (creates the file if missing)",
        name: "lunora-queue",
    },
    options: {
        name: {
            prompt: "Queue name (e.g. emailQueue)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error("invalid queue name: name must be a non-empty string");
        }

        const exportName = camelCase(raw);
        const queuesPath = join(builtins.dest_dir, "lunora", "queues.ts");

        const suggestions = ["Run `lunora codegen` (or just `lunora dev`) to emit `ctx.queues` + the queue() handler and reconcile wrangler.jsonc."];

        if (!existsSync(queuesPath)) {
            return {
                files: { lunora: { "queues.ts": freshQueues(exportName) } },
                suggestions: [`Created lunora/queues.ts with queue "${exportName}".`, ...suggestions],
            };
        }

        const original = readFileSync(queuesPath, "utf8");

        if (new RegExp(String.raw`\bexport\s+const\s+${exportName}\b`, "u").test(original)) {
            throw new Error(`queue "${exportName}" already exists in ${queuesPath} — pick a different name.`);
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { lunora: { "queues.ts": `${original}${separator}${definitionFor(exportName)}` } },
            filesMeta: { "lunora/queues.ts": { force: true } },
            suggestions: [`Added queue "${exportName}" to lunora/queues.ts.`, ...suggestions],
        };
    },
});
