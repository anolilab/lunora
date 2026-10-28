/**
 * Cloudflare Queues — codegen wires `ctx.queues.<name>.send(...)` on mutations
 * and actions, and the Worker's `queue()` consumer.
 *
 * A consumer runs with the system identity (no end-user RLS), so every message
 * body is validated before anything acts on it.
 */
import { defineQueue } from "@lunora/queue";
import * as z from "zod";

import { internal } from "./_generated/internal.js";

const domainEventSchema = z.object({ kind: z.string().min(1).max(64), organizationId: z.string().min(1), subjectId: z.string().optional() });

/** Domain events: fan out into the tenant's notification feed, and drive per-tenant maintenance. */
export const events = defineQueue<z.infer<typeof domainEventSchema>>({
    handler: async (context, batch) => {
        for (const message of batch.messages) {
            const parsed = domainEventSchema.safeParse(message.body);

            if (!parsed.success) {
                context.log.warn("dropping malformed event", { issues: parsed.error.issues.length });
                message.ack();

                continue;
            }

            const { kind, organizationId, subjectId } = parsed.data;

            // eslint-disable-next-line no-await-in-loop -- one message at a time: each is acked only after its own write lands
            await (kind === "maintenance.sweep"
                ? message.run(internal.tasks.sweepDone, { before: Date.now() - 30 * 86_400_000, organizationId }, { shardKey: organizationId })
                : message.run(internal.notifications.record, { kind, organizationId, subjectId }, { shardKey: organizationId }));
            message.ack();
        }
    },
    maxRetries: 3,
});

/** Outbound mail, so a slow provider never holds a mutation open. */
export const mail = defineQueue<{ subject: string; text: string; to: string }>({
    handler: async (_context, batch) => {
        for (const message of batch.messages) {
            // eslint-disable-next-line no-await-in-loop -- one send at a time: a provider rate limit must not fail the whole batch
            await message.run(internal.mail.sendEmail, message.body);
            message.ack();
        }
    },
    maxRetries: 5,
});
