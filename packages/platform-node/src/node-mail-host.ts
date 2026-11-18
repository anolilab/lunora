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

import { createHash } from "node:crypto";

import { LunoraError } from "@lunora/errors";
import type { MailEnv, Mailer, MailTransport, QueueLike, SentMailStore } from "@lunora/mail";
import {
    consumeQueuedSend,
    createMailer,
    createMailerFromEnv,
    isOutcomeUnknownMailError,
    isRetryableMailError,
    MailSendError,
    shouldCaptureMail,
} from "@lunora/mail";
import type { MessageBatchLike } from "@lunora/platform";
import { defineQueue } from "@lunora/queue";
import type Database from "better-sqlite3";

import { allowReservedQueueName, createNodeQueueHost, preparedSendOf, RESERVED_MAIL_QUEUE_NAME } from "./node-queue-host";

/** The queue name the registry's `wrangler.jsonc` example gives the mail queue. */
const MAIL_QUEUE_NAME = RESERVED_MAIL_QUEUE_NAME;

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

/**
 * How long `consumeQueuedSend`'s attempt marks live: 15 days, its
 * `ATTEMPT_MARK_TTL_SECONDS` at the default `sentTtlSeconds`. A redelivery older
 * than this would find no evidence of an earlier send that may have landed.
 */
const MAIL_EVIDENCE_TTL_MS = 15 * 86_400_000;

/**
 * A mail row's idempotency key, read off its stored body. Guarded so the
 * expression never throws: on a connection shared with app queues, a `v8` or
 * `bytes` body is not JSON, and an index expression that threw would fail their
 * inserts. The same text in the index and the query, or SQLite will not use it.
 */
const ROW_KEY_SQL = "CASE WHEN content_type = 'json' AND json_valid(CAST(body AS TEXT)) THEN json_extract(CAST(body AS TEXT), '$.idempotencyKey') END";

/**
 * How long a key remembers the content it was first queued with: as long as its
 * delivery history and attempt marks, one horizon for all of a key's evidence.
 * At 24 hours, a key used one to fifteen days earlier took new content at
 * enqueue and the new mail was then dropped as a late repeat of the old send;
 * now the reuse is refused at enqueue, where the producer sees it.
 */
const MAIL_KEY_CONTENT_TTL_MS = MAIL_EVIDENCE_TTL_MS;

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
         * send with that id is parked. Throws for one queued 15 or more days ago,
         * whose attempt record in the sent ledger has expired.
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

/** How often the sent ledger drops expired rows. A read ignores them anyway, so this only bounds the table. */
const LEDGER_PRUNE_INTERVAL_MS = 60_000;

/**
 * The sent-mail ledger `consumeQueuedSend` dedupes on, in the same database as
 * the queue, so every process on the file shares it. A read ignores expired
 * rows, as Workers KV's TTL would; a write prunes them, at most once a minute
 * and through an index, since each send writes two or three rows that live for
 * 15 days and the prune holds the write lock the shard and app queues share.
 */
const createSentLedger = (database: Database.Database, clock: () => number): SentMailStore => {
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_mail_sent (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_mail_sent_expires ON _lunora_mail_sent (expires_at)");

    const read = database.prepare<[string, number], { value: string }>("SELECT value FROM _lunora_mail_sent WHERE key = ? AND expires_at > ?");
    const write = database.prepare<[string, string, number]>(
        "INSERT INTO _lunora_mail_sent (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    );
    const prune = database.prepare<[number]>("DELETE FROM _lunora_mail_sent WHERE expires_at <= ?");
    let prunedAt = Number.NEGATIVE_INFINITY;

    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async for KV; SQLite is synchronous
        get: async (key) => read.get(key, clock())?.value,
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async for KV; SQLite is synchronous
        put: async (key, value, { expirationTtl }) => {
            const now = clock();

            if (now - prunedAt >= LEDGER_PRUNE_INTERVAL_MS) {
                prune.run(now);
                prunedAt = now;
            }

            write.run(key, value, now + expirationTtl * 1000);
        },
    };
};

/** A value as JSON with its object keys sorted, so the same content always hashes the same. */
const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    }

    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([a], [b]) => (a < b ? -1 : 1));

        return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`).join(",")}}`;
    }

    return JSON.stringify(value);
};

/** A recipient field as the consumer reads it: a lone address and a one-element list are the same, an empty list is absent. */
const recipientList = (value: unknown): unknown => {
    const list = typeof value === "string" ? [value] : value;

    return Array.isArray(list) && list.length === 0 ? undefined : list;
};

/**
 * The mail a body would send, hashed: only the fields `consumeQueuedSend` reads,
 * with recipients normalized as it normalizes them, so two bodies that send the
 * same mail never read as a conflict. The key itself is left out; it is what
 * the record is stored under.
 */
const fingerprintOf = (body: unknown): string => {
    const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

    return createHash("sha256")
        .update(
            canonicalJson({
                bcc: recipientList(fields.bcc),
                cc: recipientList(fields.cc),
                from: fields.from,
                headers: fields.headers,
                html: fields.html,
                replyTo: fields.replyTo,
                subject: fields.subject,
                text: fields.text,
                to: recipientList(fields.to),
            }),
        )
        .digest("hex");
};

/** One delivery at a time per idempotency key, and one content per key, across polls and processes on the file. */
interface KeyClaims {
    /** When the key was first delivered, while its history lives; `undefined` for a key never delivered. */
    firstDeliveredAt: (key: string) => number | undefined;

    /** Keep the key's content record at least as long as the sent record a successful send just wrote. */
    keepContent: (key: string) => void;

    release: (key: string, messageId: string) => void;

    /**
     * Reserve the key for this content and run `insert`, the row's insert, in ONE
     * `BEGIN IMMEDIATE` transaction: `"conflict"` when the key already belongs to
     * different content, and then nothing is written.
     *
     * One transaction because two would leave a reservation without its row, visible
     * to every other process on the file. A second process's failed enqueue could
     * then see no live row and drop the reservation, a third reserve the key for
     * other content, and the first's row land afterwards to be parked as a conflict.
     * Here a reservation commits only with its row, and an insert that throws rolls
     * the reservation back with it, so a failed enqueue needs no cleanup.
     */
    reserve: (key: string, fingerprint: string, insert: () => void) => "conflict" | "queued";

    /**
     * Take the key for this delivery of `messageId`: `"busy"` while another
     * delivery holds it, `"conflict"` when the key names different content, or
     * the key's delivery number when taken.
     */
    take: (key: string, fingerprint: string, messageId: string, enqueuedAt: number) => TakeOutcome;
}

/**
 * A key's deliveries are numbered across every queue row that carries it, and
 * that number, not the row's own `attempts`, is what `consumeQueuedSend` keys
 * its attempt marks on. With row attempts, a second row of one key started over
 * at 1: it skipped the late-redelivery check altogether, and its marks overwrote
 * the first row's, so a definite failure there could hide an outcome-unknown one.
 * Row attempts still drive the queue's retry budget.
 */
/** The named parameters of the delivery-history upsert (better-sqlite3 binds `@name`, not `?NNN`). */
type NextDeliveryParameters = { enqueued: number; excluded: string; expires: number; key: string; now: number };

type TakeOutcome = { delivery: number; firstDeliveredAt: number; outcome: "taken" } | { outcome: "busy" } | { outcome: "conflict" };

/**
 * Claims taken before a send, in one immediate transaction with the content
 * check: two queued rows with one key, claimed by overlapping polls or two
 * processes, would otherwise both pass the ledger's "not yet sent" read before
 * either recorded the send.
 *
 * A claim names the queue row holding it. The claim starts after the row's
 * lease (when the send starts, not when the batch was claimed), so after a crash
 * the redelivered row would otherwise find its own claim still live and wait as
 * if another delivery held it, spending attempts until it parked unsent. Another
 * row's claim lapses on its own lease; `DO NOTHING` would hold the key forever.
 *
 * The content record exists because the ledger answers by key alone: a key
 * reused for a different message would otherwise be acked as already sent. It is
 * written at enqueue, so the first message queued under a key owns it whatever
 * order the rows are delivered in; delivery records it only for a row queued
 * before any record existed. Both tables are pruned at most once a minute.
 */
const createKeyClaims = (database: Database.Database, clock: () => number): KeyClaims => {
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_mail_claims (key TEXT PRIMARY KEY, message_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_mail_claims_expires ON _lunora_mail_claims (expires_at)");
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_mail_keys (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_mail_keys_expires ON _lunora_mail_keys (expires_at)");
    // Outlives every attempt mark it numbered: each delivery refreshes it for the marks' 15 days.
    // `first_at` is when the provider may first have seen the key: its dedupe window runs from
    // there, not from the enqueue of whichever row carries the key now.
    database.exec(
        "CREATE TABLE IF NOT EXISTS _lunora_mail_deliveries (key TEXT PRIMARY KEY, delivery INTEGER NOT NULL, first_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_mail_deliveries_expires ON _lunora_mail_deliveries (expires_at)");

    const claim = database.prepare<[string, string, number, number]>(
        `INSERT INTO _lunora_mail_claims (key, message_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET message_id = excluded.message_id, expires_at = excluded.expires_at
         WHERE _lunora_mail_claims.expires_at <= ? OR _lunora_mail_claims.message_id = excluded.message_id`,
    );
    const drop = database.prepare<[string, string]>("DELETE FROM _lunora_mail_claims WHERE key = ? AND message_id = ?");
    const readContent = database.prepare<[string, number], { fingerprint: string }>(
        "SELECT fingerprint FROM _lunora_mail_keys WHERE key = ? AND expires_at > ?",
    );
    const writeContent = database.prepare<[string, string, number]>(
        "INSERT INTO _lunora_mail_keys (key, fingerprint, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET fingerprint = excluded.fingerprint, expires_at = excluded.expires_at",
    );
    const pruneClaims = database.prepare<[number]>("DELETE FROM _lunora_mail_claims WHERE expires_at <= ?");
    const pruneContent = database.prepare<[number]>("DELETE FROM _lunora_mail_keys WHERE expires_at <= ?");
    // A key's delivery history outlives its own expiry for as long as a queued, retrying or
    // parked row that was queued BEFORE that expiry still carries the key: that row's sends are
    // judged against it, and a history dropped under it would make a duplicate of an
    // already-sent mail look like a first send. A row queued after the expiry is a new use of
    // the key, so it neither keeps the old history alive nor blocks its reset: two fresh
    // matching sends would otherwise inherit the expired history and both be refused. Both
    // statements read the queue table, which the queue host creates after these claims, so
    // they are prepared on first use.
    const otherLiveRowOfKey = `EXISTS (SELECT 1 FROM _lunora_queue_messages WHERE queue = '${MAIL_QUEUE_NAME}' AND state IN ('pending', 'dead') AND ${ROW_KEY_SQL} = _lunora_mail_deliveries.key AND id <> @excluded AND enqueued_at < _lunora_mail_deliveries.expires_at)`;
    // Named parameters: better-sqlite3 binds anonymous `?` and `@name`, not numbered `?NNN`.
    let pruneDeliveriesStatement: Database.Statement<[{ excluded: string; now: number }]> | undefined;
    let nextDeliveryStatement: Database.Statement<[NextDeliveryParameters], { delivery: number; first_at: number }> | undefined;
    const pruneDeliveries = (now: number): void => {
        pruneDeliveriesStatement ??= database.prepare<[{ excluded: string; now: number }]>(
            `DELETE FROM _lunora_mail_deliveries WHERE NOT ${otherLiveRowOfKey} AND expires_at <= @now`,
        );
        // No row is being delivered here, so no id is excluded from "another live row".
        pruneDeliveriesStatement.run({ excluded: "", now });
    };
    // A history resets only for a row queued after it had already expired: a new use of the key
    // past the horizon. The row being delivered, retrying, or a duplicate queued while the
    // evidence lived, keeps counting from the key's first delivery, as does any other live row.
    const nextDelivery = (key: string, now: number, messageId: string, enqueuedAt: number): { delivery: number; first_at: number } | undefined => {
        const reset = `_lunora_mail_deliveries.expires_at <= @now AND @enqueued >= _lunora_mail_deliveries.expires_at AND NOT ${otherLiveRowOfKey}`;

        nextDeliveryStatement ??= database.prepare<[NextDeliveryParameters], { delivery: number; first_at: number }>(
            `INSERT INTO _lunora_mail_deliveries (key, delivery, first_at, expires_at) VALUES (@key, 1, @now, @expires)
             ON CONFLICT (key) DO UPDATE SET
                 delivery = CASE WHEN ${reset} THEN 1 ELSE _lunora_mail_deliveries.delivery + 1 END,
                 first_at = CASE WHEN ${reset} THEN excluded.first_at ELSE _lunora_mail_deliveries.first_at END,
                 expires_at = excluded.expires_at
             RETURNING delivery, first_at`,
        );

        return nextDeliveryStatement.get({ enqueued: enqueuedAt, excluded: messageId, expires: now + MAIL_EVIDENCE_TTL_MS, key, now });
    };
    const readFirstDelivery = database.prepare<[string], { first_at: number }>("SELECT first_at FROM _lunora_mail_deliveries WHERE key = ?");
    const extendContent = database.prepare<[number, string]>("UPDATE _lunora_mail_keys SET expires_at = max(expires_at, ?) WHERE key = ?");
    let prunedAt = Number.NEGATIVE_INFINITY;

    // Prepared on first use: the queue host creates `_lunora_queue_messages` after these claims.
    let oldestLiveRow: Database.Statement<[string], { body: Buffer }> | undefined;

    /**
     * The content a key belongs to: its record while that lives, otherwise the
     * oldest queued, retrying or parked row that still carries the key, judged by
     * that row's own stored body. The record lapses 15 days after the key's last
     * delivery (`MAIL_EVIDENCE_TTL_MS`), but a delayed, retrying or parked row can
     * outlive it; without the rows, a later
     * enqueue with other content would take the key and the old row would be
     * judged a conflict when it finally came due.
     */
    const liveRowFor = (key: string): { body: Buffer } | undefined => {
        oldestLiveRow ??= database.prepare<[string], { body: Buffer }>(
            `SELECT body FROM _lunora_queue_messages WHERE queue = '${MAIL_QUEUE_NAME}' AND state IN ('pending', 'dead') AND ${ROW_KEY_SQL} = ? ORDER BY enqueued_at LIMIT 1`,
        );

        return oldestLiveRow.get(key);
    };

    const ownerFingerprint = (key: string, now: number): { fingerprint: string; recorded: boolean } | undefined => {
        const known = readContent.get(key, now)?.fingerprint;

        if (known !== undefined) {
            return { fingerprint: known, recorded: true };
        }

        const row = liveRowFor(key);

        return row === undefined ? undefined : { fingerprint: fingerprintOf(JSON.parse(row.body.toString("utf8")) as unknown), recorded: false };
    };

    const pruneDue = (now: number): void => {
        if (now - prunedAt >= LEDGER_PRUNE_INTERVAL_MS) {
            pruneClaims.run(now);
            pruneContent.run(now);
            pruneDeliveries(now);
            prunedAt = now;
        }
    };

    const reserveInTransaction = database.transaction((key: string, fingerprint: string, insert: () => void): "conflict" | "queued" => {
        const now = clock();

        pruneDue(now);

        const owner = ownerFingerprint(key, now);

        if (owner !== undefined && owner.fingerprint !== fingerprint) {
            return "conflict";
        }

        // A first record, or a re-record for a live row whose record had lapsed, so the next lookup is a read.
        if (owner?.recorded !== true) {
            writeContent.run(key, fingerprint, now + MAIL_KEY_CONTENT_TTL_MS);
        }

        insert();

        return "queued";
    });

    const takeInTransaction = database.transaction((key: string, fingerprint: string, messageId: string, enqueuedAt: number): TakeOutcome => {
        const now = clock();

        pruneDue(now);

        const owner = ownerFingerprint(key, now);

        if (owner !== undefined && owner.fingerprint !== fingerprint) {
            return { outcome: "conflict" };
        }

        if (claim.run(key, messageId, now + MAIL_VISIBILITY_TIMEOUT_MS, now).changes === 0) {
            return { outcome: "busy" };
        }

        // Refreshed, not only written when absent: the record must outlast the send this claim
        // starts (up to the lease), and `keepContent` then extends it to the sent record's life.
        writeContent.run(key, fingerprint, Math.max(now + MAIL_KEY_CONTENT_TTL_MS, now + MAIL_VISIBILITY_TIMEOUT_MS));

        const numbered = nextDelivery(key, now, messageId, enqueuedAt);

        return { delivery: numbered?.delivery ?? 1, firstDeliveredAt: numbered?.first_at ?? now, outcome: "taken" };
    });

    return {
        firstDeliveredAt: (key) => readFirstDelivery.get(key)?.first_at,
        keepContent: (key) => {
            extendContent.run(clock() + MAIL_KEY_CONTENT_TTL_MS, key);
        },
        release: (key, messageId) => {
            drop.run(key, messageId);
        },
        reserve: (key, fingerprint, insert) => reserveInTransaction.immediate(key, fingerprint, insert),
        take: (key, fingerprint, messageId, enqueuedAt) => takeInTransaction.immediate(key, fingerprint, messageId, enqueuedAt),
    };
};

/** The queued body's idempotency key, when it carries a usable one; `consumeQueuedSend` refuses the rest. */
const idempotencyKeyOf = (body: unknown): string | undefined => {
    const key = body !== null && typeof body === "object" ? (body as { idempotencyKey?: unknown }).idempotencyKey : undefined;

    return typeof key === "string" && key !== "" ? key : undefined;
};

/**
 * Cloudflare Queues' ceiling on a message delay: "Messages can be delayed by up to
 * 24 hours" (developers.cloudflare.com/queues/configuration/batching-retries/).
 */
const MAX_DELAY_SECONDS = 86_400;

/**
 * A delay as Cloudflare Queues takes one: a whole number of seconds from 0 to 24
 * hours. Checked here because the queue host below clamps instead (a negative
 * delay or NaN to 0, a fraction up, an oversized one to the ceiling), and a
 * clamped delay is mail that goes out earlier than the caller asked.
 */
const assertValidDelay: (delaySeconds: unknown) => asserts delaySeconds is number | undefined = (delaySeconds) => {
    if (delaySeconds === undefined) {
        return;
    }

    if (typeof delaySeconds !== "number" || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: \`delaySeconds\` must be a whole number of seconds from 0 to ${String(MAX_DELAY_SECONDS)} (24 hours), as on Cloudflare Queues, got ${typeof delaySeconds === "number" ? String(delaySeconds) : JSON.stringify(delaySeconds)}`,
        );
    }
};

/** The `LUNORA_MAIL_CAPTURE` values `shouldCaptureMail` obeys; any other value is ignored. */
const CAPTURE_FLAG_VALUES: ReadonlySet<string> = new Set(["0", "1", "false", "true"]);

/**
 * The variable that decided capture, as `shouldCaptureMail` decides it: an
 * obeyed `LUNORA_MAIL_CAPTURE`, otherwise the environment variables it read as dev.
 */
const captureTrigger = (env: MailEnv): string => {
    const flag = env["LUNORA_MAIL_CAPTURE"];

    if (typeof flag === "string" && CAPTURE_FLAG_VALUES.has(flag.toLowerCase())) {
        return `LUNORA_MAIL_CAPTURE=${flag}`;
    }

    return ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"]
        .flatMap((name) => (typeof env[name] === "string" && env[name] !== "" ? [`${name}=${env[name]}`] : []))
        .join(", ");
};

/** A `LUNORA_MAIL_CAPTURE` value `shouldCaptureMail` ignored, so the reader sees why it did not count. */
const ignoredCaptureFlag = (env: MailEnv): string => {
    const flag = env["LUNORA_MAIL_CAPTURE"];

    return typeof flag === "string" && flag !== "" && !CAPTURE_FLAG_VALUES.has(flag.toLowerCase())
        ? `; LUNORA_MAIL_CAPTURE=${flag} was ignored, as only 1, true, 0 or false are read`
        : "";
};

/**
 * Say, once and at startup, that mail will be captured rather than sent. The rule
 * is `createMailerFromEnv`'s, the same as on Cloudflare, so `NODE_ENV=test`
 * captures here too; but Node tooling sets `NODE_ENV` on its own, and on a plain
 * Node env nothing records the capture, so it must not happen quietly.
 */
const announceCapture = (env: MailEnv): void => {
    const recorded = env["SHARD"] !== undefined && typeof env["LUNORA_ADMIN_TOKEN"] === "string";
    const fate = recorded
        ? "recorded in the studio's Mail inbox"
        : "DISCARDED, because there is no SHARD namespace and LUNORA_ADMIN_TOKEN on env to record it with";

    // eslint-disable-next-line no-console -- the package has no logger; the process's stderr is the log
    console.warn(
        `[@lunora/platform-node] mail is captured, not sent (${captureTrigger(env)} selects dev capture${ignoredCaptureFlag(env)}): every send is ${fate}. Set LUNORA_MAIL_CAPTURE=0 to deliver.`,
    );
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
        announceCapture(env);

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

/** What the consumer needs besides the batch. */
interface MailConsumer {
    claims: KeyClaims;
    clock: () => number;
    mailer: Mailer;
    sent: SentMailStore;

    /** Rows found superseded during a batch, parked once the batch has settled. */
    superseded: Set<string>;
}

/** Retry a send whose key another delivery holds: it is settled by then, and the ledger answers for it. */
const retryBusyKey = (message: MessageBatchLike["messages"][number], key: string): void => {
    const busy = new Error(`another delivery of idempotency key "${key}" is in flight`);

    logFailure(
        message.attempts > MAIL_MAX_RETRIES ? "error" : "warn",
        message.attempts > MAIL_MAX_RETRIES ? "lunora.mail.send_dead_lettered" : "lunora.mail.send_key_busy",
        message.attempts,
        busy,
    );
    message.retry({ delaySeconds: OUTCOME_UNKNOWN_RETRY_SECONDS });
};

/** Ack a delivery nothing should send, with an error an operator can alert on. */
const refuse = (message: MessageBatchLike["messages"][number], event: string, reason: string): void => {
    logFailure("error", event, message.attempts, new Error(reason));
    message.ack();
};

/**
 * Take the message's key, or settle the message and answer `undefined` when the
 * claim itself fails. A SQLite error here is a failed delivery like any other: it
 * is logged with the key, the attempt and the cause chain, and retried or parked
 * on the same rule. Outside this, it escaped the batch, which the queue host
 * retried with no log at all until the row parked in silence.
 */
const claimFor = (consumer: MailConsumer, message: MessageBatchLike["messages"][number], key: string | undefined): TakeOutcome | undefined => {
    // A body without a key is refused by `consumeQueuedSend` before any mark is written, so the row's count serves.
    if (key === undefined) {
        return { delivery: message.attempts, firstDeliveredAt: message.timestamp.getTime(), outcome: "taken" };
    }

    try {
        return consumer.claims.take(key, fingerprintOf(message.body), message.id, message.timestamp.getTime());
    } catch (error) {
        settleFailure(message, new MailSendError({ cause: error, message: `@lunora/mail: could not claim idempotency key "${key}"`, retryable: true }));

        return undefined;
    }
};

/** Run bookkeeping that follows a delivery, logging its failure as its own event instead of failing the message. */
const afterSend = (message: MessageBatchLike["messages"][number], event: string, work: () => void): void => {
    try {
        work();
    } catch (error) {
        logFailure("error", event, message.attempts, error);
    }
};

/** Deliver one message under its key's claim, and settle it on its own outcome. */
const deliver = async (consumer: MailConsumer, message: MessageBatchLike["messages"][number]): Promise<void> => {
    const key = idempotencyKeyOf(message.body);
    const claimed = claimFor(consumer, message, key);

    if (claimed === undefined) {
        return;
    }

    if (claimed.outcome === "conflict") {
        // Parked, never acked: this is real mail whose key another message owns, and an ack would
        // drop it without a trace. A long retry keeps it out of reach until the poll parks it.
        logFailure(
            "error",
            "lunora.mail.idempotency_key_conflict",
            message.attempts,
            new Error(`idempotency key "${String(key)}" belongs to different content; this send is parked in deadLetters, not sent`),
        );
        consumer.superseded.add(message.id);
        message.retry({ delaySeconds: MAX_DELAY_SECONDS });

        return;
    }

    if (claimed.outcome === "busy") {
        retryBusyKey(message, String(key));

        return;
    }

    // Every route back into delivery passes here: a retry, a lapsed lease, a requeue, or a row
    // left pending while nothing polled. The key's history decides, not this row's age: an
    // earlier row may have sent the key, and the provider can first have seen it at the key's
    // first delivery, never at an enqueue. So the attempt marks' lifetime and the dedupe window
    // both run from that first delivery. A row first polled long after it was queued is a
    // fresh first attempt, and its transient failure is retried like any other.
    const sinceMs = claimed.firstDeliveredAt;

    if (claimed.delivery > 1 && consumer.clock() - sinceMs >= MAIL_EVIDENCE_TTL_MS) {
        if (key !== undefined) {
            consumer.claims.release(key, message.id);
        }

        refuse(
            message,
            "lunora.mail.send_evidence_expired",
            "an earlier delivery of this key may have been sent, and its record in the sent ledger has expired",
        );

        return;
    }

    // `consumeQueuedSend` ages the message against Date.now(), so its enqueue time is moved
    // by the gap between the two clocks: the dedupe window is then measured on the host clock,
    // the one every other timestamp here comes from.
    const enqueuedAt = new Date(Date.now() - (consumer.clock() - sinceMs));

    try {
        try {
            await consumeQueuedSend(consumer.mailer, message.body, { attempts: claimed.delivery, enqueuedAt, sent: consumer.sent });
        } catch (error) {
            settleFailure(message, error);

            return;
        }

        // Sent: nothing past this point is a send failure. An error here must neither be logged
        // as a refusal nor retry a message the provider already accepted.
        message.ack();

        if (key !== undefined) {
            afterSend(message, "lunora.mail.content_record_failed", () => {
                consumer.claims.keepContent(key);
            });
        }
    } finally {
        if (key !== undefined) {
            // Non-fatal: an unreleased claim lapses with the row's lease. Thrown, it ended the
            // batch early and left the messages after this one for a redelivery.
            afterSend(message, "lunora.mail.claim_release_failed", () => {
                consumer.claims.release(key, message.id);
            });
        }
    }
};

/**
 * The message, with its retry delay counted from now rather than from the
 * batch's start. The queue host settles a whole batch on the poll's clock
 * reading, so without this a send that failed late in a slow batch would be due
 * again before its delay, possibly while the first request is still in flight.
 */
const retryingFromNow = (message: MessageBatchLike["messages"][number], elapsedSeconds: () => number): MessageBatchLike["messages"][number] => {
    return {
        ...message,
        retry: (options) => {
            message.retry({ delaySeconds: (options?.delaySeconds ?? 0) + elapsedSeconds() });
        },
    };
};

/** Send each message of a batch in turn. */
const consumeBatch = async (consumer: MailConsumer, batch: MessageBatchLike): Promise<void> => {
    const startedAt = consumer.clock();
    const elapsedSeconds = (): number => Math.ceil(Math.max(0, consumer.clock() - startedAt) / 1000);

    for (const message of batch.messages) {
        // eslint-disable-next-line no-await-in-loop -- one send at a time, so a provider rate limit fails one message, not the batch
        await deliver(consumer, retryingFromNow(message, elapsedSeconds));
    }
};

/**
 * Create queued mail delivery over `database`: a durable `lunora-mail` queue, a
 * mailer whose `queue()` writes to it, and `poll()` to drain it through the given
 * `transport` or, without one, Resend (`RESEND_API_KEY`). In a dev environment
 * the mailer captures instead, exactly as `createMailerFromEnv` decides on
 * Cloudflare. Throws when `MAIL_FROM` is unset or nothing can deliver.
 *
 * Give it a connection nothing else opens a transaction on, ideally a file of
 * its own, as `createNodePlatform({ mail: { path } })` does: on a shard host's
 * connection, a poll during `shard.transaction()` writes inside it, and that
 * transaction's rollback would undo the acks and sent records and resend.
 */
const createNodeMailHost = (database: Database.Database, options: NodeMailHostOptions = {}): NodeMailHost => {
    const env: MailEnv = options.env ?? { ...process.env };
    const clock = options.now ?? Date.now;
    const queue: QueueLike = {
        // eslint-disable-next-line @typescript-eslint/require-await -- QueueLike's contract is async; the reservation and insert are one synchronous transaction
        send: async (payload, sendOptions) => {
            const { delaySeconds, ...unsupported } = sendOptions ?? {};

            // Refused rather than dropped: a caller treating this like a Queue binding would
            // otherwise get an immediate send, and a non-JSON `contentType` a body the consumer refuses.
            if (Object.keys(unsupported).length > 0) {
                throw new LunoraError(
                    "VALIDATION_ERROR",
                    `@lunora/platform-node: the mail queue takes only a \`delaySeconds\` option, got ${Object.keys(unsupported).join(", ")}`,
                );
            }

            assertValidDelay(delaySeconds);

            // Validated and encoded here, outside the transaction: a body the queue refuses (the
            // 128 KiB ceiling) throws before anything is reserved, so there is nothing to undo.
            // The key and the fingerprint come from what will be STORED, not from `payload`:
            // delivery fingerprints the stored body, and a `toJSON()` can make the two differ, which
            // would reserve one content and queue another, to be parked at delivery as a conflict.
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called only after construction returns, by which point `host` is assigned
            const { insert, stored } = preparedSendOf(host, "mail")(payload, delaySeconds === undefined ? undefined : { delaySeconds });
            const key = idempotencyKeyOf(stored);

            if (key === undefined) {
                // `consumeQueuedSend` refuses a body without a key; queued as-is so the refusal is logged there.
                insert();

                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- see above, for `consumer`
            if (consumer.claims.reserve(key, fingerprintOf(stored), insert) === "conflict") {
                throw new LunoraError(
                    "VALIDATION_ERROR",
                    `@lunora/platform-node: idempotency key "${key}" was already queued with different content — a key names one message, so use a new key for new content`,
                );
            }
        },
    };
    // Built before the tables, so a refusal leaves nothing behind in the database.
    const mailer = buildMailer(env, queue, options.transport);
    const consumer: MailConsumer = {
        claims: createKeyClaims(database, clock),
        clock,
        mailer,
        sent: createSentLedger(database, clock),
        superseded: new Set(),
    };
    // The one host allowed the reserved `lunora-mail` name.
    const host = createNodeQueueHost(
        database,
        allowReservedQueueName({
            now: clock,
            onBatch: async (batch) => {
                await consumeBatch(consumer, batch);
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
        }),
    );
    // The lookup `createKeyClaims` makes when a key's record has lapsed. Partial, so only mail rows
    // are indexed and an app queue's non-JSON bodies never reach the expression.
    database.exec(
        `CREATE INDEX IF NOT EXISTS _lunora_mail_row_keys ON _lunora_queue_messages ((${ROW_KEY_SQL}), enqueued_at) WHERE queue = '${MAIL_QUEUE_NAME}'`,
    );

    const park = database.prepare<[string]>(
        `UPDATE _lunora_queue_messages SET state = 'dead' WHERE id = ? AND queue = '${MAIL_QUEUE_NAME}' AND state = 'pending'`,
    );

    // Scoped to this queue, unlike the queue host's own requeue: the table is shared with the
    // app's queues. Attempts are kept, not reset, because `consumeQueuedSend` reads them to tell
    // a redelivery from a first send.
    const revive = database.prepare<[number, string, string]>(
        "UPDATE _lunora_queue_messages SET state = 'pending', visible_at = ? WHERE id = ? AND queue = ? AND state = 'dead'",
    );
    const parkedAt = database.prepare<[string, string], { body: Buffer; enqueued_at: number }>(
        "SELECT body, enqueued_at FROM _lunora_queue_messages WHERE id = ? AND queue = ? AND state = 'dead'",
    );
    const inFlight = new Set<Promise<number>>();

    const requeue = (id: string): boolean => {
        const row = parkedAt.get(id, MAIL_QUEUE_NAME);

        if (row === undefined) {
            return false;
        }

        // Refused here, loudly, rather than revived and then refused by `deliver`: the operator
        // asking is the one who needs to know the send cannot be replayed safely. Measured on the
        // clock `deliver` uses, the key's first delivery; a parked row always has one.
        const key = idempotencyKeyOf(JSON.parse(row.body.toString("utf8")) as unknown);
        const since = (key === undefined ? undefined : consumer.claims.firstDeliveredAt(key)) ?? row.enqueued_at;

        if (clock() - since >= MAIL_EVIDENCE_TTL_MS) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: parked mail ${id} was first attempted 15 or more days ago, so the record of whether an earlier attempt was sent has expired — check the provider's logs and queue it again if it never arrived`,
            );
        }

        return revive.run(clock(), id, MAIL_QUEUE_NAME).changes > 0;
    };

    return {
        deadLetters: {
            list: () => host.deadLetters.list(MAIL_QUEUE_NAME),
            requeue,
        },
        drain: async () => {
            await Promise.allSettled(inFlight);
        },
        mailer,
        poll: async (now) => {
            const run = host.poll(now).finally(() => {
                for (const id of consumer.superseded) {
                    park.run(id);
                }

                consumer.superseded.clear();
            });

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

export { createNodeMailHost };
export type { NodeMailHost, NodeMailHostOptions };
