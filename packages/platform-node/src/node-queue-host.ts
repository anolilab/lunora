/**
 * `createNodeQueueHost` — the Node implementation of the `@lunora/queue`
 * binding surface: a `QueueBindingLike` producer per declared queue, and a
 * batched consumer that hands `MessageBatchLike` to the same
 * `dispatchQueueBatch` the Cloudflare host uses.
 *
 * `_lunora_queue_messages` lives on the same `better-sqlite3` connection as the
 * shard, KV, socket, scheduler and workflow tables, so a queue survives a
 * restart for the same reason those do, and `poll()` picks up messages whose
 * visibility elapsed while nothing was running. (Why a table rather than an
 * existing queue library: `plans/306-pluggable-queue-drivers.md` §0 and §1.3.)
 *
 * # Delivery semantics
 *
 * - `visible_at` carries `delaySeconds` on send, and the retry backoff after a
 * failed attempt. A message is invisible until then, which is also how the
 * in-flight window works: claiming a batch pushes `visible_at` out by
 * `visibilityTimeoutMs`, so a crash mid-handler redelivers rather than loses.
 * - `attempts` increments per delivery. On exceeding `maxRetries` the message
 * moves to `deadLetterQueue` if one is declared — as a real message on that
 * queue, so its consumer sees it — and is otherwise parked `state = 'dead'`
 * rather than deleted, because a dropped message with no trace is the thing
 * that makes a queue impossible to debug.
 * - `mode: "pull"` queues are still written to; nothing here consumes them, and
 * `poll()` skips them.
 */

import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";

import { LunoraError } from "@lunora/errors";
import type { MessageBatchLike, MessageLike, MessageSendRequestLike, QueueBindingLike, QueueContentType, QueueSendOptions } from "@lunora/platform";
import type { QueueDefinition } from "@lunora/queue";
import { isQueueDefinition, queueBindingName, queueDefaultName } from "@lunora/queue";
import type Database from "better-sqlite3";

/** Cloudflare's defaults for the tuning a queue does not set. */
const DEFAULTS = {
    maxBatchSize: 10,
    maxBatchTimeoutSeconds: 5,
    maxRetries: 3,
    retryDelaySeconds: 0,
    visibilityTimeoutMs: 30_000,
};

/** Cloudflare caps a per-message delay at 12 hours. */
const MAX_DELAY_SECONDS = 43_200;

/** Row shape of `_lunora_queue_messages`. */
interface MessageRow {
    attempts: number;
    body: Buffer;
    content_type: string;
    enqueued_at: number;
    id: string;
    queue: string;
    visible_at: number;
}

/** Serialize a body for storage under the queue's wire content type. */
const encodeBody = (body: unknown, contentType: QueueContentType): Buffer => {
    switch (contentType) {
        case "bytes": {
            if (body instanceof ArrayBuffer) {
                return Buffer.from(body);
            }

            if (ArrayBuffer.isView(body)) {
                return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
            }

            throw new LunoraError("VALIDATION_ERROR", '@lunora/platform-node: queue contentType "bytes" needs an ArrayBuffer or a typed array');
        }
        case "text": {
            if (typeof body !== "string") {
                throw new LunoraError("VALIDATION_ERROR", '@lunora/platform-node: queue contentType "text" needs a string');
            }

            return Buffer.from(body, "utf8");
        }
        case "v8": {
            return serialize(body);
        }
        default: {
            // `null`, not `undefined`: `JSON.stringify(undefined)` returns
            // `undefined`, which is not a string and cannot be stored.
            // eslint-disable-next-line unicorn/no-null -- see above
            return Buffer.from(JSON.stringify(body ?? null), "utf8");
        }
    }
};

/** Inverse of {@link encodeBody}. */
const decodeBody = (stored: Buffer, contentType: string): unknown => {
    switch (contentType) {
        case "bytes": {
            return stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
        }
        case "text": {
            return stored.toString("utf8");
        }
        case "v8": {
            return deserialize(stored);
        }
        default: {
            return JSON.parse(stored.toString("utf8")) as unknown;
        }
    }
};

/**
 * Decode a stored body, or surface the failure as a value rather than throwing.
 *
 * Used by the dead-letter listing, where one unreadable row must not take down
 * the whole list — the parked rows are precisely the ones most likely to hold
 * something malformed, and they are the ones an operator is trying to look at.
 */
const safeDecode = (row: { body: Buffer; content_type: string }): unknown => {
    try {
        return decodeBody(row.body, row.content_type);
    } catch {
        return undefined;
    }
};

/** Clamp a caller-supplied delay to the range the contract documents. */
const delayMs = (delaySeconds: number | undefined): number => {
    if (delaySeconds === undefined || !Number.isFinite(delaySeconds)) {
        return 0;
    }

    return Math.min(Math.max(0, Math.floor(delaySeconds)), MAX_DELAY_SECONDS) * 1000;
};

/** One declared queue, resolved from its `defineQueue` result. */
interface CompiledQueue {
    definition: QueueDefinition;
    exportName: string;
    name: string;
}

/** Options for {@link createNodeQueueHost}. */
interface NodeQueueHostOptions<Queues extends Record<string, { isLunoraQueue: true }>> {
    /** Base env merged under the derived `QUEUE_*` bindings. */
    env?: Record<string, unknown>;

    /**
     * The host's clock, in epoch ms. Producers and `poll()` share it, so a
     * `delaySeconds` written by `send` is measured against the same reading
     * `poll` compares it to. Defaults to `Date.now`.
     *
     * Injectable because otherwise the two diverge: a test that captures
     * `Date.now()`, sends, and then polls at `captured + delay` misses by however
     * many milliseconds elapsed in between — and the dead-letter re-enqueue,
     * which stamps `enqueued_at` from the poll clock, mixes two clocks in one
     * column.
     */
    now?: () => number;

    /**
     * Deliver one assembled batch. Wire this to `dispatchQueueBatch` from
     * `@lunora/queue` — the host owns storage and batching, not routing, which is
     * the same split the Cloudflare host has.
     *
     * A rejection retries every message the handler left undecided, matching
     * workerd; a normal return acks them.
     */
    onBatch: (batch: MessageBatchLike) => Promise<void> | void;
    /** The declared queues keyed by their `lunora/queues.ts` export name. */
    queues: Queues;

    /** How long a claimed batch stays invisible before redelivery. Defaults to 30s. */
    visibilityTimeoutMs?: number;
}

/** A fully-wired Node queue host. */
interface NodeQueueHost<Queues extends Record<string, { isLunoraQueue: true }>> {
    /** Per-export-name `QueueBindingLike` — the map `ctx.queues` consumes. */
    readonly bindings: { [K in keyof Queues]: QueueBindingLike };

    /**
     * The parked messages — those that exhausted `maxRetries` with no
     * `deadLetterQueue` declared.
     *
     * `list` + `requeue`, mirroring `SchedulerHost.deadLetter` rather than
     * inspection alone: this host justifies parking with "a dropped message with
     * no trace is the thing that makes a queue impossible to debug", and a trace
     * you can read but not act on is only half of that.
     */
    deadLetters: {
        list: (queue: string) => { attempts: number; body: unknown; id: string }[];
        /** Return a parked message to its queue with `attempts` reset. `false` when no such message is parked. */
        requeue: (id: string) => boolean;
    };
    /** The caller's `env` plus one `QUEUE_<EXPORT>` binding per queue. */
    readonly env: Record<string, unknown>;

    /**
     * Deliver every batch currently due, one per queue per call, and return how
     * many batches were delivered. Drives the consumer — nothing here runs on a
     * timer, because this host has no dev server to own one yet.
     */
    poll: (now?: number) => Promise<number>;
}

/**
 * Create a Node queue host: one durable table behind every declared queue, a
 * producer binding per queue, and `poll()` to drive the consumer.
 */
export const createNodeQueueHost = <Queues extends Record<string, { isLunoraQueue: true }>>(
    database: Database.Database,
    options: NodeQueueHostOptions<Queues>,
): NodeQueueHost<Queues> => {
    database.pragma("journal_mode = WAL");
    database.exec(`CREATE TABLE IF NOT EXISTS _lunora_queue_messages (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        body BLOB NOT NULL,
        content_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        visible_at INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
    )`);
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_queue_messages_due ON _lunora_queue_messages (queue, state, visible_at)");

    const insert = database.prepare<[string, string, Buffer, string, number, number]>(
        "INSERT INTO _lunora_queue_messages (id, queue, body, content_type, visible_at, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)",
    );

    /**
     * Claim a batch in ONE statement: select, hide and count the delivery
     * together, returning what was taken.
     *
     * A `SELECT` followed by a separate `UPDATE` is not enough. Within one
     * process the two are safe — `better-sqlite3` is synchronous, so nothing
     * interleaves between them — but two processes on one file both read the
     * same pending rows before either hides them, and both deliver, each telling
     * its handler `attempts: 1`. The consumer cannot even see that it happened.
     * That is not hypothetical here: this table runs in WAL mode and the
     * workflow store beside it exists for "two processes sharing one file".
     */
    const claimBatch = database.prepare<[number, string, number, number], MessageRow>(
        `UPDATE _lunora_queue_messages
         SET attempts = attempts + 1, visible_at = ?
         WHERE id IN (
             SELECT id FROM _lunora_queue_messages
             WHERE queue = ? AND state = 'pending' AND visible_at <= ?
             ORDER BY visible_at, enqueued_at LIMIT ?
         )
         RETURNING *`,
    );
    // Rescheduling only moves the message; the claim is what counts a delivery.
    const reschedule = database.prepare<[number, string]>("UPDATE _lunora_queue_messages SET visible_at = ? WHERE id = ?");
    const remove = database.prepare<[string]>("DELETE FROM _lunora_queue_messages WHERE id = ?");
    const park = database.prepare<[string]>("UPDATE _lunora_queue_messages SET state = 'dead' WHERE id = ?");
    const oldestPending = database.prepare<[string, number], { enqueued_at: number }>(
        "SELECT enqueued_at FROM _lunora_queue_messages WHERE queue = ? AND state = 'pending' AND visible_at <= ? ORDER BY enqueued_at LIMIT 1",
    );
    const countPending = database.prepare<[string, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM _lunora_queue_messages WHERE queue = ? AND state = 'pending' AND visible_at <= ?",
    );
    const listDead = database.prepare<[string], MessageRow>("SELECT * FROM _lunora_queue_messages WHERE queue = ? AND state = 'dead' ORDER BY enqueued_at");
    const revive = database.prepare<[number, string]>(
        "UPDATE _lunora_queue_messages SET state = 'pending', attempts = 0, visible_at = ? WHERE id = ? AND state = 'dead'",
    );

    const compiled: CompiledQueue[] = Object.entries(options.queues).map(([exportName, value]) => {
        if (!isQueueDefinition(value)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: "${exportName}" is not a defineQueue result`);
        }

        return { definition: value, exportName, name: value.name ?? queueDefaultName(exportName) };
    });

    const declared = new Set(compiled.map((queue) => queue.name));

    // Checked once, at construction, because both failures are silent at runtime:
    // a queue that dead-letters to itself re-enqueues with `attempts` reset and
    // redelivers forever, and one that dead-letters to a name nothing declares
    // writes a row on a queue no consumer polls — invisible to `poll()`, invisible
    // to `deadLetters()`, and never reaped. Cloudflare rejects the self-reference
    // at config time; this is the same check, at the only point this host has.
    for (const queue of compiled) {
        const target = queue.definition.deadLetterQueue;

        if (target === undefined) {
            continue;
        }

        if (target === queue.name) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: queue "${queue.name}" names itself as its own deadLetterQueue, which would redeliver forever`,
            );
        }

        if (!declared.has(target)) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: queue "${queue.name}" names deadLetterQueue "${target}", which no declared queue provides — its dead letters would be unreachable`,
            );
        }
    }

    const visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULTS.visibilityTimeoutMs;
    const clock = options.now ?? Date.now;

    const enqueue = (queueName: string, body: unknown, contentType: QueueContentType, delay: number, now: number): void => {
        insert.run(randomUUID(), queueName, encodeBody(body, contentType), contentType, now + delay, now);
    };

    /** Settle one message: ack deletes it, retry re-arms it, an exhausted retry dead-letters or parks it. */
    const settle = (row: MessageRow, queue: CompiledQueue, outcome: "ack" | "retry", retryDelaySeconds: number | undefined, now: number): void => {
        if (outcome === "ack") {
            remove.run(row.id);

            return;
        }

        const maxRetries = queue.definition.maxRetries ?? DEFAULTS.maxRetries;

        // `row.attempts` comes back from `claimBatch`'s `RETURNING`, so it is
        // already the number of the delivery that just failed.
        //
        // Dead-letter once deliveries EXCEED `maxRetries`, because `maxRetries`
        // counts retries *after* the initial delivery — the same
        // `attempts > maxRetries` boundary `@lunora/queue`'s `dispatchQueueBatch`
        // uses to set `deadLettered`. At `>=` the two disagreed: this host buried
        // the message one delivery early, and every message it buried was
        // captured `deadLettered: false`, so the Studio Queues panel could never
        // show one.
        if (row.attempts > maxRetries) {
            const deadLetter = queue.definition.deadLetterQueue;

            if (deadLetter === undefined) {
                park.run(row.id);
            } else {
                // Re-enqueued as a real message on the dead-letter queue rather
                // than flagged in place, so that queue's consumer receives it the
                // way it receives anything else.
                enqueue(deadLetter, decodeBody(row.body, row.content_type), row.content_type as QueueContentType, 0, now);
                remove.run(row.id);
            }

            return;
        }

        const delay = delayMs(retryDelaySeconds ?? queue.definition.retryDelay ?? DEFAULTS.retryDelaySeconds);

        reschedule.run(now + delay, row.id);
    };

    const bindings: Record<string, QueueBindingLike> = {};
    const env: Record<string, unknown> = { ...options.env };

    for (const queue of compiled) {
        const binding: QueueBindingLike = {
            // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async so a real binding can await the network; SQLite is synchronous
            send: async (message: unknown, sendOptions?: QueueSendOptions): Promise<unknown> => {
                enqueue(queue.name, message, sendOptions?.contentType ?? "json", delayMs(sendOptions?.delaySeconds), clock());

                return undefined;
            },
            // eslint-disable-next-line @typescript-eslint/require-await -- see `send`
            sendBatch: async (messages: Iterable<MessageSendRequestLike>, batchOptions?: { delaySeconds?: number }): Promise<unknown> => {
                const now = clock();
                const batchDelay = delayMs(batchOptions?.delaySeconds);

                // One transaction: a half-written batch is the failure mode a
                // caller cannot see and cannot undo.
                database.transaction(() => {
                    for (const message of messages) {
                        const delay = message.delaySeconds === undefined ? batchDelay : delayMs(message.delaySeconds);

                        enqueue(queue.name, message.body, message.contentType ?? "json", delay, now);
                    }
                })();

                return undefined;
            },
        };

        bindings[queue.exportName] = binding;
        env[queueBindingName(queue.exportName)] = binding;
    }

    /** Assemble and deliver one batch for `queue`, or return false when nothing is due. */
    const deliverOne = async (queue: CompiledQueue, now: number): Promise<boolean> => {
        const maxBatchSize = Math.min(Math.max(1, queue.definition.maxBatchSize ?? DEFAULTS.maxBatchSize), 100);
        const pending = countPending.get(queue.name, now)?.n ?? 0;

        if (pending === 0) {
            return false;
        }

        // A partial batch waits for `maxBatchTimeout` so a trickle of messages
        // is not delivered one at a time; a full batch goes immediately.
        if (pending < maxBatchSize) {
            const oldest = oldestPending.get(queue.name, now)?.enqueued_at;
            // Clamped to the 0-60 the contract documents; `maxBatchSize` was
            // already clamped and this was not, so a negative value silently
            // turned every batch into a single-message delivery.
            const timeoutMs = Math.min(Math.max(0, queue.definition.maxBatchTimeout ?? DEFAULTS.maxBatchTimeoutSeconds), 60) * 1000;

            if (oldest !== undefined && now - oldest < timeoutMs) {
                return false;
            }
        }

        // One statement, so the rows are hidden and counted in the same write
        // that selects them — see `claimBatch`. `.immediate()` takes the write
        // lock up front rather than upgrading mid-transaction, which is what
        // makes the claim safe against a second process rather than merely
        // against a second call in this one.
        const rows = database.transaction(() => claimBatch.all(now + visibilityTimeoutMs, queue.name, now, maxBatchSize)).immediate();

        if (rows.length === 0) {
            return false;
        }

        const decided = new Map<string, { delaySeconds?: number; outcome: "ack" | "retry" }>();

        const messages: MessageLike[] = rows.map((row) => {
            return {
                ack: () => {
                    decided.set(row.id, { outcome: "ack" });
                },
                attempts: row.attempts,
                body: decodeBody(row.body, row.content_type),
                id: row.id,
                retry: (retryOptions?: { delaySeconds?: number }) => {
                    decided.set(row.id, { delaySeconds: retryOptions?.delaySeconds, outcome: "retry" });
                },
                timestamp: new Date(row.enqueued_at),
            };
        });

        const batch: MessageBatchLike = {
            ackAll: () => {
                for (const row of rows) {
                    decided.set(row.id, { outcome: "ack" });
                }
            },
            messages,
            queue: queue.name,
            retryAll: (retryOptions?: { delaySeconds?: number }) => {
                for (const row of rows) {
                    decided.set(row.id, { delaySeconds: retryOptions?.delaySeconds, outcome: "retry" });
                }
            },
        };

        // workerd's rule: a handler that returns acks whatever it left undecided,
        // and a handler that throws retries it.
        let undecided: "ack" | "retry" = "ack";

        try {
            await options.onBatch(batch);
        } catch {
            undecided = "retry";
        }

        // Settled on the batch's own clock. `poll(now)` is the caller's notion of
        // time and a retry delay measured against `Date.now()` instead would drift
        // from it by however long the handler ran.
        database.transaction(() => {
            for (const row of rows) {
                const decision = decided.get(row.id);

                settle(row, queue, decision?.outcome ?? undecided, decision?.delaySeconds, now);
            }
        })();

        return true;
    };

    return {
        bindings: bindings as NodeQueueHost<Queues>["bindings"],
        deadLetters: {
            list: (queueName: string) =>
                listDead.all(queueName).map((row) => {
                    return { attempts: row.attempts, body: safeDecode(row), id: row.id };
                }),
            requeue: (id: string) => revive.run(clock(), id).changes > 0,
        },
        env,
        poll: async (now = clock()): Promise<number> => {
            let delivered = 0;

            for (const queue of compiled) {
                // Pull queues are written to but never consumed here — an external
                // worker polls them over HTTP, which this host does not serve.
                if (queue.definition.mode === "pull") {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- queues are settled one at a time so a batch's writes land before the next queue is claimed
                if (await deliverOne(queue, now)) {
                    delivered += 1;
                }
            }

            return delivered;
        },
    };
};

export type { NodeQueueHost, NodeQueueHostOptions };
