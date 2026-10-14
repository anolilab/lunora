/**
 * `vis generate lunora-queue` — declare a Cloudflare Queue in lunora/queues.ts.
 *
 * If queues.ts doesn't exist yet we write a fresh one. If it does, we append the
 * new `export const <name> = defineQueue({...})` declaration(s) (exports are
 * order-independent, so a plain append is safe — no AST surgery needed). Codegen
 * discovers each export, emits the typed `ctx.queues` producer + the worker
 * `queue()` dispatch, and `lunora dev`/`lunora deploy` reconcile the wrangler
 * `queues.producers[]` / `queues.consumers[]` entries. Unlike workflows, a queue
 * needs no worker-entry class re-export — its consumer handler rides
 * `createWorker`.
 *
 * The `dlq` option (default: yes) scaffolds the production best-practice setup:
 * the queue bounds redelivery with `maxRetries` and routes exhausted messages to
 * a paired dead-letter sink instead of dropping them silently. Answer no for a
 * bare single-queue declaration (the previous default).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase, dashCase } from "./_helpers/case.js";

const IMPORT_LINE = `import { defineQueue } from "@lunora/queue";`;

/**
 * The bare declaration: one push consumer, ack on success / retry on failure.
 * Cloudflare drops a message once it exhausts `maxRetries` (default 3, ~4 total
 * attempts) with no `deadLetterQueue` set — the best-practice variant below
 * fixes that.
 */
const simpleDefinition = (exportName: string): string => `/**
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

/**
 * The best-practice pair: the queue bounds redelivery with `maxRetries` and
 * routes exhausted messages to the `<queue>-dlq` sink, plus a terminal
 * dead-letter consumer (`<queue>Dlq`) that drains them so they can't vanish.
 * Cloudflare expires an *unconsumed* DLQ at its retention window, so the sink is
 * what makes "nothing is silently lost" actually true.
 */
const bestPracticeDefinition = (exportName: string, dlqExportName: string, dlqName: string): string => `/**
 * One Cloudflare Queue (production best-practice setup). Codegen wires
 * \`ctx.queues.${exportName}\` onto mutations/actions — enqueue with
 * \`await ctx.queues.${exportName}.send(message)\`. This push consumer processes
 * each delivered batch; to touch data, call a Lunora function with
 * \`await context.run(api.<file>.<fn>, args)\`.
 *
 * Reliability defaults baked in:
 *   • \`maxRetries\` bounds redelivery; after it, a message is routed to
 *     "${dlqName}" (the \`${dlqExportName}\` sink below) instead of being dropped.
 *   • Delivery is at-least-once, so make the handler idempotent — dedupe on
 *     \`message.id\` before applying side effects.
 *   • Ack/retry per message so one poison message can't fail the whole batch.
 */
export const ${exportName} = defineQueue({
    handler: async (context, batch) => {
        for (const message of batch.messages) {
            try {
                context.log.info("processing", message.id);
                // Idempotency: skip if you've already handled \`message.id\`
                // (at-least-once delivery can redeliver a message).
                // await context.run(api.<file>.<fn>, message.body);
                message.ack();
            } catch (error) {
                context.log.error("failed", message.id, error);
                // Retry now; after \`maxRetries\` attempts the message goes to the DLQ.
                message.retry();
            }
        }
    },
    maxRetries: 3,
    deadLetterQueue: "${dlqName}",
    // Further tuning (optional): maxBatchSize: 10, maxBatchTimeout: 5, retryDelay: 30,
});

/**
 * Dead-letter sink for \`${exportName}\`. Messages that exhaust \`${exportName}\`'s
 * retries land here instead of vanishing. This terminal consumer has no DLQ of
 * its own — inspect, alert on, or persist the failed payload, then \`ack()\` so it
 * doesn't linger (an unconsumed DLQ still expires at the queue's retention).
 */
export const ${dlqExportName} = defineQueue({
    name: "${dlqName}",
    handler: async (context, batch) => {
        for (const message of batch.messages) {
            context.log.error("dead-lettered", message.id, message.body);
            // TODO: persist / alert on the exhausted message, e.g.
            // await context.run(api.<file>.recordDeadLetter, message.body);
            message.ack();
        }
    },
});
`;

const freshQueues = (body: string): string => `${IMPORT_LINE}

${body}`;

export default createTemplate({
    about: {
        description: "Declare a queue in lunora/queues.ts (creates the file if missing)",
        name: "lunora-queue",
    },
    options: {
        dlq: {
            default: true,
            prompt: "Set up the production best-practice queue (dead-letter queue + retry tuning)?",
            type: "boolean",
        },
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
        // `options.dlq` resolves to the prompt answer, a CLI `--dlq`/`--no-dlq`
        // override, or the `true` default (non-interactive runs). Best practice
        // unless the caller explicitly opts out.
        const bestPractice = options.dlq !== false;

        const dlqExportName = `${exportName}Dlq`;
        // `dashCase` mirrors `queueDefaultName` (`emailQueue` → `email-queue`), so
        // pinning the sink's wrangler `name` to `<queue>-dlq` matches what codegen
        // would derive from `${dlqExportName}` anyway — and equals the string the
        // main queue's `deadLetterQueue` points at.
        const dlqName = `${dashCase(exportName)}-dlq`;

        const body = bestPractice ? bestPracticeDefinition(exportName, dlqExportName, dlqName) : simpleDefinition(exportName);
        const newExports = bestPractice ? [exportName, dlqExportName] : [exportName];

        const queuesPath = join(builtins.dest_dir, "lunora", "queues.ts");

        const suggestions = ["Run `lunora codegen` (or just `lunora dev`) to emit `ctx.queues` + the queue() handler and reconcile wrangler.jsonc."];
        const added = bestPractice ? `queue "${exportName}" + dead-letter sink "${dlqExportName}"` : `queue "${exportName}"`;

        if (!existsSync(queuesPath)) {
            return {
                files: { lunora: { "queues.ts": freshQueues(body) } },
                suggestions: [`Created lunora/queues.ts with ${added}.`, ...suggestions],
            };
        }

        const original = readFileSync(queuesPath, "utf8");

        for (const name of newExports) {
            if (new RegExp(String.raw`\bexport\s+const\s+${name}\b`, "u").test(original)) {
                throw new Error(`queue "${name}" already exists in ${queuesPath} — pick a different name.`);
            }
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { lunora: { "queues.ts": `${original}${separator}${body}` } },
            filesMeta: { "lunora/queues.ts": { force: true } },
            suggestions: [`Added ${added} to lunora/queues.ts.`, ...suggestions],
        };
    },
});
