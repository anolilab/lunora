/**
 * `createNodeMailHost` — queued `@lunora/mail` delivery for a Node process: the
 * same split a Cloudflare app wires by hand, a `MAIL_QUEUE` producer that
 * `mailer.queue()` writes to and a consumer that drains it through
 * `consumeQueuedSend`, composed over one `createNodeQueueHost` queue.
 *
 * The queue is a row in `_lunora_queue_messages` on the caller's database, so
 * a queued send survives a restart, and a failed one is retried and finally
 * parked by the queue host's own policy rather than by a second one here.
 */

import { LunoraError } from "@lunora/errors";
import type { MailEnv, Mailer, MailTransport, QueueLike } from "@lunora/mail";
import { consumeQueuedSend, createMailer, createMailerFromEnv, isOutcomeUnknownMailError, isRetryableMailError, shouldCaptureMail } from "@lunora/mail";
import type { MessageBatchLike } from "@lunora/platform";
import { defineQueue } from "@lunora/queue";
import type Database from "better-sqlite3";

import { createNodeQueueHost } from "./node-queue-host";

/** The queue name the registry's `wrangler.jsonc` example gives the mail queue. */
const MAIL_QUEUE_NAME = "lunora-mail";

/**
 * How long an outcome-unknown send waits before it is tried again. Resend's
 * client keeps a request going for about two minutes, and a repeat that lands
 * while the first is still in flight is a 409 rather than a dropped duplicate.
 */
const OUTCOME_UNKNOWN_RETRY_SECONDS = 180;

/** Options for {@link createNodeMailHost}. */
interface NodeMailHostOptions {
    /**
     * Where `MAIL_FROM`, `RESEND_API_KEY` and the capture switches
     * (`LUNORA_MAIL_CAPTURE`, `WORKER_ENV`, …) are read, once, at construction.
     * `process.env` unless given.
     */
    env?: MailEnv;

    /** The host clock, shared with the queue host so a retry delay and `poll(now)` agree. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Deliver through this instead of Resend: an SMTP client, another provider,
     * or a test double. Without it `RESEND_API_KEY` must be set. Ignored while
     * the env selects capture, as `createMailerFromEnv` ignores a transport then.
     */
    transport?: MailTransport;
}

/** Queued mail delivery for one Node process. */
interface NodeMailHost {
    /** Sends that failed past the queue's retries, parked by the queue host rather than dropped. */
    deadLetters: {
        list: () => { attempts: number; body: unknown; id: string }[];
        /** Return a parked send to the queue with its attempts reset. `false` when no such send is parked. */
        requeue: (id: string) => boolean;
    };

    /** `queue()` enqueues onto {@link NodeMailHost.queue}; `send()` delivers now through the same transport. */
    mailer: Mailer;

    /** Deliver the queued sends that are due, and return how many batches went out. Nothing here runs on a timer. */
    poll: (now?: number) => Promise<number>;

    /**
     * The producer: pass it as `createMailerFromEnv(env, { queue })` or put it on
     * the worker's env as `MAIL_QUEUE`, where the registry's `mailer()` reads it.
     */
    queue: QueueLike;
}

/** One JSON log line per failed send, the shape `@lunora/mail` logs its own events in. */
const logFailure = (level: "error" | "warn", event: string, attempts: number, error: unknown): void => {
    const line = JSON.stringify({
        attempts,
        error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
        event,
        queue: MAIL_QUEUE_NAME,
    });

    // eslint-disable-next-line no-console -- the package has no logger; the process's stderr is the log
    console[level](`[@lunora/platform-node] ${line}`);
};

/**
 * The mailer the consumer sends through. Refuses one that could only queue:
 * `createMailer` would build it, and every message would then fail at consume
 * time, be retried and parked, without one going out.
 */
const buildMailer = (env: MailEnv, queue: QueueLike, transport: MailTransport | undefined): Mailer => {
    const from = env["MAIL_FROM"];

    if (typeof from !== "string" || from === "") {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: mail needs MAIL_FROM, the default sender");
    }

    if (shouldCaptureMail(env)) {
        return createMailerFromEnv(env, { queue });
    }

    if (transport !== undefined) {
        return createMailer({ from, queue, transport });
    }

    const apiKey = env["RESEND_API_KEY"];

    if (typeof apiKey !== "string" || apiKey === "") {
        throw new LunoraError(
            "VALIDATION_ERROR",
            "@lunora/platform-node: mail has nothing to deliver through — set RESEND_API_KEY or pass `transport` (Cloudflare Email Workers' send_email binding does not exist on Node)",
        );
    }

    return createMailer({ apiKey, from, queue });
};

/**
 * Settle each message the way the `consumeQueuedSend` consumer in `@lunora/mail`'s
 * docs does: a retryable failure is retried, anything else is acked and logged,
 * because a retry of a send that may have landed with no provider dedupe could
 * mail a second copy.
 */
const consumeBatch = async (mailer: Mailer, batch: MessageBatchLike): Promise<void> => {
    for (const message of batch.messages) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one send at a time, so a provider rate limit fails one message, not the batch
            await consumeQueuedSend(mailer, message.body, { attempts: message.attempts, enqueuedAt: message.timestamp });
            message.ack();
        } catch (error) {
            if (isRetryableMailError(error)) {
                logFailure("warn", "lunora.mail.send_retry", message.attempts, error);
                message.retry(isOutcomeUnknownMailError(error) ? { delaySeconds: OUTCOME_UNKNOWN_RETRY_SECONDS } : undefined);
            } else {
                logFailure(
                    "error",
                    isOutcomeUnknownMailError(error) ? "lunora.mail.send_outcome_unknown" : "lunora.mail.send_refused",
                    message.attempts,
                    error,
                );
                message.ack();
            }
        }
    }
};

/**
 * Create queued mail delivery over `database`: a durable `lunora-mail` queue, a
 * mailer whose `queue()` writes to it, and `poll()` to drain it through Resend
 * (`RESEND_API_KEY`) or the given `transport`. In a dev environment the mailer
 * captures instead, exactly as `createMailerFromEnv` decides on Cloudflare.
 * Throws when `MAIL_FROM` is unset or nothing can deliver.
 */
const createNodeMailHost = (database: Database.Database, options: NodeMailHostOptions = {}): NodeMailHost => {
    const env: MailEnv = options.env ?? { ...process.env };
    const queue: QueueLike = {
        send: async (payload) => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called only after construction returns, by which point `host` is assigned
            await host.bindings.mail.send(payload);
        },
    };
    // Built before the queue table, so a refusal leaves nothing behind in the database.
    const mailer = buildMailer(env, queue, options.transport);
    const host = createNodeQueueHost(database, {
        now: options.now,
        onBatch: async (batch) => {
            await consumeBatch(mailer, batch);
        },
        // No batch window: a verification code or reset link must not wait for nine more sends.
        queues: { mail: defineQueue({ handler: () => undefined, maxBatchTimeout: 0, name: MAIL_QUEUE_NAME }) },
    });

    return {
        deadLetters: {
            list: () => host.deadLetters.list(MAIL_QUEUE_NAME),
            requeue: (id) => host.deadLetters.requeue(id),
        },
        mailer,
        poll: async (now) => await host.poll(now),
        queue,
    };
};

export { createNodeMailHost, MAIL_QUEUE_NAME };
export type { NodeMailHost, NodeMailHostOptions };
