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
    // Exhausted messages go to `notifications-dlq` rather than being dropped.
    // Without this, a message that burns its 3 attempts is gone with no record —
    // and the Studio's DLQ badge (which this example exists to demonstrate) could
    // never appear. The advisor flags a queue without one for exactly that reason.
    deadLetterQueue: "notifications-dlq",
    // Dead-letter a message after 3 delivery attempts (the Cloudflare default).
    maxRetries: 3,
});

/**
 * The dead-letter queue for {@link notifications}.
 *
 * Declaring a DLQ is only half the job: an unconsumed queue still expires its
 * messages at the retention window, so the record you dead-lettered a message to
 * preserve quietly evaporates. This consumer acks and logs each one, which is
 * what makes the Studio's Queues panel able to show it — and what makes the
 * one-click redrive there have something to redrive.
 */
export const notificationsDlq = defineQueue<Notification>({
    handler: (context, batch) => {
        for (const message of batch.messages) {
            context.log.warn("notification dead-lettered", { id: message.id, kind: message.body.kind, to: message.body.to });
            // Acked, not retried: this message already exhausted its attempts on
            // the parent queue. Retrying here would just burn this queue's budget
            // too and then drop it for real.
            message.ack();
        }
    },
});
