/**
 * Cloudflare Queues — codegen wires `ctx.queues.<name>.send(...)` on mutations
 * and actions, and the Worker's `queue()` consumer.
 *
 * A consumer runs with the system identity (no end-user RLS), so every message
 * body is validated before anything acts on it.
 */
import { consumeQueuedSend } from "@lunora/mail";
import { defineQueue } from "@lunora/queue";
import * as z from "zod";

import { internal } from "./_generated/internal";
import { mailer } from "./mail/transport";

const domainEventSchema = z.object({ kind: z.string().min(1).max(64), organizationId: z.string().min(1), subjectId: z.string().optional() });

/** Domain events: fan out into the tenant's notification feed, and drive per-tenant maintenance and headline refreshes. */
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
            const onTenant = { shardKey: organizationId };
            const refreshHeadline = async () => message.run(internal.insights.refreshHeadline, { organizationId }, onTenant);
            let work: Promise<unknown>;

            if (kind === "maintenance.sweep") {
                work = message.run(internal.tasks.sweepDone, { before: Date.now() - 30 * 86_400_000, organizationId }, onTenant).then(refreshHeadline);
            } else if (kind === "headline.refresh") {
                work = refreshHeadline();
            } else {
                work = message.run(internal.notifications.record, { kind, organizationId, subjectId }, onTenant);
            }

            // eslint-disable-next-line no-await-in-loop -- one message at a time: each is acked only after its own writes land
            await work;
            message.ack();
        }
    },
    maxRetries: 3,
});

/**
 * Outbound mail, so a slow provider never holds a mutation open. The body is what
 * `queueEmail` enqueued (`toQueuedPayload`), consumed by the mail package, which
 * skips a send that already reached the provider and tells a redelivery apart.
 */
export const mail = defineQueue<unknown>({
    handler: async (_context, batch) => {
        const transport = mailer();

        for (const message of batch.messages) {
            // eslint-disable-next-line no-await-in-loop -- one send at a time: a provider rate limit must not fail the whole batch
            await consumeQueuedSend(transport, message.body, { attempts: message.attempts, enqueuedAt: message.timestamp });
            message.ack();
        }
    },
    maxRetries: 5,
});
