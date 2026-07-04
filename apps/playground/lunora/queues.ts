/**
 * Example Cloudflare Queue: an async notification fan-out.
 *
 * Codegen discovers this `defineQueue` export and wires two things:
 *   - a typed producer on every mutation/action ctx — enqueue with
 *     `await ctx.queues.notifications.send({ to, kind })`;
 *   - the worker `queue()` push consumer (the `handler` below), which processes
 *     each delivered batch.
 *
 * You can also enqueue straight from **Studio → Queues → Send** (the test
 * sender), then watch the outcome land in the consumed-message log — Cloudflare
 * Queues have no peek API, so the log is what the consumer actually processed.
 *
 * ⚠️ A queue handler is trusted server code: its `ctx.run(...)` calls run with
 * the system identity (end-user RLS is not applied), so validate `message.body`
 * before acting on it — see the `@lunora/queue` docs.
 */
import { defineQueue } from "@lunora/queue";

/**
 * The notification payload enqueued onto the queue.
 *
 * A normal body is delivered and acked. `fail` and `retry` are demo levers for
 * the Studio Queues panel — send them from the Send tab to exercise the other
 * outcomes so every badge (ack / retry / error / DLQ) shows.
 */
interface Notification {
    /** Enqueue `{ "fail": true }` to make the handler throw → an `error` outcome (dead-lettered after `maxRetries`). */
    fail?: boolean;
    /** What kind of notification this is, e.g. "mention" or "digest". */
    kind?: string;
    /** Enqueue `{ "retry": true }` to have the handler ask for redelivery → a `retry` outcome. */
    retry?: boolean;
    /** Who to notify (an email or user id). */
    to?: string;
}

export const notifications = defineQueue<Notification>({
    handler: (context, batch) => {
        for (const message of batch.messages) {
            const { fail, kind, retry, to } = message.body;

            context.log.info("delivering notification", { id: message.id, kind, to });

            // Real delivery would go here, e.g.:
            //   await context.run(api.mail.send, { to, template: kind });

            if (fail) {
                // Throwing surfaces an `error` outcome; workerd retries the batch and
                // the message dead-letters once its attempts reach `maxRetries`.
                throw new Error(`notification delivery failed for ${to ?? "unknown recipient"}`);
            }

            if (retry) {
                message.retry();
            } else {
                message.ack();
            }
        }
    },
    // Dead-letter a message after 3 delivery attempts (the Cloudflare default).
    // Add `deadLetterQueue: "notifications-dlq"` to also route exhausted messages
    // to another queue for inspection.
    maxRetries: 3,
});
