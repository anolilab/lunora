/**
 * `createNodeMailHost` — queued `@lunora/mail` delivery for a Node process: the
 * same split a Cloudflare app wires by hand, a `MAIL_QUEUE` producer that
 * `mailer.queue()` writes to and a consumer that drains it through
 * `consumeQueuedSend`, composed over one `createNodeQueueHost` queue.
 *
 * The queue is a row in `_lunora_queue_messages` on the caller's database, so
 * a queued send survives a restart, and a failed one is retried and finally
 * parked by the queue host's own policy rather than by a second one here.
 *
 * # Delivery semantics
 *
 * At-least-once, narrowed, never exactly-once. A claimed batch is hidden for
 * longer than it can take to send (see {@link MAIL_VISIBILITY_TIMEOUT_MS}), so an
 * overlapping `poll()` or a second process on the same file never takes a row
 * that is still being sent. `_lunora_mail_sent` records each sent idempotency key
 * and the attempt marks `consumeQueuedSend` keeps, so a second enqueue of a sent
 * key is acked unsent and a redelivery past Resend's dedupe window is refused
 * when an earlier attempt may have landed. What nothing here can close is a
 * crash after the provider accepted a send and before its key was recorded: that
 * redelivers, and only a provider that dedupes on the key (Resend) drops it.
 * Batches are claimed oldest first; a retried send goes behind newer ones.
 */

import { LunoraError } from "@lunora/errors";
import type { MailEnv, Mailer, MailTransport, QueueLike, SentMailStore } from "@lunora/mail";
import { consumeQueuedSend, createMailer, createMailerFromEnv, isOutcomeUnknownMailError, isRetryableMailError, shouldCaptureMail } from "@lunora/mail";
import type { MessageBatchLike } from "@lunora/platform";
import { defineQueue } from "@lunora/queue";
import type Database from "better-sqlite3";

import { createNodeQueueHost } from "./node-queue-host";

/** The queue name the registry's `wrangler.jsonc` example gives the mail queue. */
const MAIL_QUEUE_NAME = "lunora-mail";

/** Sends claimed per batch; the batch runs them one after another. */
const MAIL_BATCH_SIZE = 10;

/** Retries after the first delivery before a send is parked — the queue host's default, stated so the log can tell. */
const MAIL_MAX_RETRIES = 3;

/** `send()`'s deadline, passed to the mailer so the lease below is computed from the same number. */
const MAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * How long a claimed batch stays hidden. It must outlast the whole batch, or a
 * second poll reclaims a row whose send is still awaited and mails it again:
 * every send may run to its deadline, plus the four sent-ledger calls per send
 * (`consumeQueuedSend` bounds each at 10 s, though SQLite answers at once), plus a
 * minute of slack. The cost is that a crash mid-batch redelivers this late.
 */
const MAIL_VISIBILITY_TIMEOUT_MS = MAIL_BATCH_SIZE * (MAIL_SEND_TIMEOUT_MS + 4 * 10_000) + 60_000;

/**
 * How long an outcome-unknown send waits before it is tried again. Resend's
 * client keeps a request going for about two minutes, and a repeat that lands
 * while the first is still in flight is a 409 rather than a dropped duplicate.
 */
const OUTCOME_UNKNOWN_RETRY_SECONDS = 180;

/** How deep a logged error's `cause` chain is followed. */
const MAX_CAUSE_DEPTH = 3;

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
     * Deliver through this, an SMTP client, another provider or a test double.
     * It wins over `RESEND_API_KEY`, which is only read without it. Ignored while
     * the env selects capture, as `createMailerFromEnv` ignores a transport then.
     */
    transport?: MailTransport;
}

/** Queued mail delivery for one Node process. */
interface NodeMailHost {
    /** Sends that failed past the queue's retries, parked by the queue host rather than dropped. */
    deadLetters: {
        list: () => { attempts: number; body: unknown; id: string }[];

        /**
         * Return a parked send to the queue for one more delivery. Its attempt
         * count is kept, so a send an earlier attempt may have delivered is
         * refused once the provider no longer dedupes it. `false` when no mail
         * send with that id is parked.
         */
        requeue: (id: string) => boolean;
    };

    /** Wait for every `poll()` in flight. `createNodePlatform`'s `drain()` calls it before the database can close. */
    drain: () => Promise<void>;

    /** `queue()` enqueues onto {@link NodeMailHost.queue}; `send()` delivers now through the same transport. */
    mailer: Mailer;

    /** Deliver the queued sends that are due, and return how many batches went out. Nothing here runs on a timer. */
    poll: (now?: number) => Promise<number>;

    /**
     * The producer: pass it as `createMailerFromEnv(env, { queue })` in your own
     * module. A queued body needs an `idempotencyKey`, which `mailer.queue()` mints.
     */
    queue: QueueLike;
}

interface LoggedError {
    cause?: LoggedError;
    message: string;
    name?: string;
    stack?: string;
}

/**
 * An error as a log field, with its `cause` chain: `createMailer` wraps a
 * transport's own error in a generic "send failed", so the cause is where the
 * reason is. Only errors are walked, never the mail payload.
 */
const describeError = (error: unknown, depth = 0): LoggedError => {
    if (!(error instanceof Error)) {
        return { message: String(error) };
    }

    return {
        message: error.message,
        name: error.name,
        stack: error.stack,
        ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH && { cause: describeError(error.cause, depth + 1) }),
    };
};

/** One JSON log line per failed send, the shape `@lunora/mail` logs its own events in. */
const logFailure = (level: "error" | "warn", event: string, attempts: number, error: unknown): void => {
    const line = JSON.stringify({ attempts, error: describeError(error), event, queue: MAIL_QUEUE_NAME });

    // eslint-disable-next-line no-console -- the package has no logger; the process's stderr is the log
    console[level](`[@lunora/platform-node] ${line}`);
};

/**
 * The sent-mail ledger `consumeQueuedSend` dedupes on, in the same database as
 * the queue, so every process on the file shares it. Expired rows are pruned on
 * write; a read ignores them, as Workers KV's TTL would.
 */
const createSentLedger = (database: Database.Database, clock: () => number): SentMailStore => {
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_mail_sent (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");

    const read = database.prepare<[string, number], { value: string }>("SELECT value FROM _lunora_mail_sent WHERE key = ? AND expires_at > ?");
    const write = database.prepare<[string, string, number]>(
        "INSERT INTO _lunora_mail_sent (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    );
    const prune = database.prepare<[number]>("DELETE FROM _lunora_mail_sent WHERE expires_at <= ?");

    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async for KV; SQLite is synchronous
        get: async (key) => read.get(key, clock())?.value,
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async for KV; SQLite is synchronous
        put: async (key, value, { expirationTtl }) => {
            const now = clock();

            prune.run(now);
            write.run(key, value, now + expirationTtl * 1000);
        },
    };
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
        return createMailerFromEnv(env, { queue, sendTimeoutMs: MAIL_SEND_TIMEOUT_MS });
    }

    if (transport !== undefined) {
        return createMailer({ from, queue, sendTimeoutMs: MAIL_SEND_TIMEOUT_MS, transport });
    }

    const apiKey = env["RESEND_API_KEY"];

    if (typeof apiKey !== "string" || apiKey === "") {
        throw new LunoraError(
            "VALIDATION_ERROR",
            "@lunora/platform-node: mail has nothing to deliver through — set RESEND_API_KEY or pass `transport` (Cloudflare Email Workers' send_email binding does not exist on Node)",
        );
    }

    return createMailer({ apiKey, from, queue, sendTimeoutMs: MAIL_SEND_TIMEOUT_MS });
};

/**
 * Settle a failed send the way the `consumeQueuedSend` consumer in `@lunora/mail`'s
 * docs does: a retryable failure is retried, anything else is acked and logged,
 * because a retry of a send that may have landed with no provider dedupe could
 * mail a second copy. A retry the queue host will park instead is logged as an
 * error, since nothing tries that send again.
 */
const settleFailure = (message: MessageBatchLike["messages"][number], error: unknown): void => {
    if (!isRetryableMailError(error)) {
        logFailure("error", isOutcomeUnknownMailError(error) ? "lunora.mail.send_outcome_unknown" : "lunora.mail.send_refused", message.attempts, error);
        message.ack();

        return;
    }

    if (message.attempts > MAIL_MAX_RETRIES) {
        logFailure("error", "lunora.mail.send_dead_lettered", message.attempts, error);
    } else {
        logFailure("warn", "lunora.mail.send_retry", message.attempts, error);
    }

    message.retry(isOutcomeUnknownMailError(error) ? { delaySeconds: OUTCOME_UNKNOWN_RETRY_SECONDS } : undefined);
};

/** Send each message of a batch in turn, settling each on its own outcome. */
const consumeBatch = async (mailer: Mailer, sent: SentMailStore, batch: MessageBatchLike): Promise<void> => {
    for (const message of batch.messages) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one send at a time, so a provider rate limit fails one message, not the batch
            await consumeQueuedSend(mailer, message.body, { attempts: message.attempts, enqueuedAt: message.timestamp, sent });
            message.ack();
        } catch (error) {
            settleFailure(message, error);
        }
    }
};

/**
 * Create queued mail delivery over `database`: a durable `lunora-mail` queue, a
 * mailer whose `queue()` writes to it, and `poll()` to drain it through the given
 * `transport` or, without one, Resend (`RESEND_API_KEY`). In a dev environment
 * the mailer captures instead, exactly as `createMailerFromEnv` decides on
 * Cloudflare. Throws when `MAIL_FROM` is unset or nothing can deliver.
 */
const createNodeMailHost = (database: Database.Database, options: NodeMailHostOptions = {}): NodeMailHost => {
    const env: MailEnv = options.env ?? { ...process.env };
    const clock = options.now ?? Date.now;
    const queue: QueueLike = {
        send: async (payload) => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called only after construction returns, by which point `host` is assigned
            await host.bindings.mail.send(payload);
        },
    };
    // Built before the tables, so a refusal leaves nothing behind in the database.
    const mailer = buildMailer(env, queue, options.transport);
    const sent = createSentLedger(database, clock);
    const host = createNodeQueueHost(database, {
        now: clock,
        onBatch: async (batch) => {
            await consumeBatch(mailer, sent, batch);
        },
        // No batch window: a verification code or reset link must not wait for nine more sends.
        queues: {
            mail: defineQueue({
                handler: () => undefined,
                maxBatchSize: MAIL_BATCH_SIZE,
                maxBatchTimeout: 0,
                maxRetries: MAIL_MAX_RETRIES,
                name: MAIL_QUEUE_NAME,
            }),
        },
        visibilityTimeoutMs: MAIL_VISIBILITY_TIMEOUT_MS,
    });
    // Scoped to this queue, unlike the queue host's own requeue: the table is shared with the
    // app's queues. Attempts are kept, not reset, because `consumeQueuedSend` reads them to tell
    // a redelivery from a first send.
    const revive = database.prepare<[number, string, string]>(
        "UPDATE _lunora_queue_messages SET state = 'pending', visible_at = ? WHERE id = ? AND queue = ? AND state = 'dead'",
    );
    const inFlight = new Set<Promise<number>>();

    return {
        deadLetters: {
            list: () => host.deadLetters.list(MAIL_QUEUE_NAME),
            requeue: (id) => revive.run(clock(), id, MAIL_QUEUE_NAME).changes > 0,
        },
        drain: async () => {
            await Promise.allSettled(inFlight);
        },
        mailer,
        poll: async (now) => {
            const run = host.poll(now);

            inFlight.add(run);

            try {
                return await run;
            } finally {
                inFlight.delete(run);
            }
        },
        queue,
    };
};

export { createNodeMailHost, MAIL_QUEUE_NAME };
export type { NodeMailHost, NodeMailHostOptions };
