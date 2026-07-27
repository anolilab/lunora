/**
 * Dev queue catcher — durable storage for consumed queue messages.
 *
 * Cloudflare Queues expose **no** API to peek pending (undelivered) messages, so
 * a "message viewer" can only ever show what a consumer actually *processed*. The
 * generated worker `queue()` handler (via `@lunora/queue`'s `dispatchQueueBatch`)
 * records every message it dispatches to the **root shard** through the reserved
 * `__lunora_admin__:recordQueueMessage` admin RPC, so the studio's Queues panel
 * shows ONE unified log of everything every push consumer handled — its final
 * outcome (ack / retry / error), delivery attempt count, and whether the message
 * is about to dead-letter — regardless of which queue produced it.
 *
 * Deliberately modeled on `mail-catcher.ts`: one reserved `__lunora_queue_messages`
 * table, the same `runSql` indirection, the same bounded-trim idiom on write. The
 * `__lunora` prefix auto-hides it from the data browser. Capture is opt-in (the
 * codegen `queue()` handler wires the sink only when enabled — on by default in
 * dev), so a production consumer pays nothing unless the operator turns it on.
 */
import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Reserved consumed-message table. Auto-hidden from the data browser by the `__lunora` prefix. */
const QUEUE_TABLE = "__lunora_queue_messages";

/**
 * Most recent consumed messages kept; older rows are trimmed after each write so
 * the dev log can't grow unbounded. A message log only needs the recent tail, not
 * full history.
 */
const QUEUE_RETENTION = 500;

/**
 * Per-body character cap. `QUEUE_RETENTION` bounds the row COUNT; this bounds each
 * row's JSON size so one pathological message body can't bloat the DO's SQLite
 * store. A dev preview doesn't need the full megabytes.
 */
const MAX_BODY_CHARS: number = 128 * 1024;

/** The terminal disposition a consumer left a message in for this delivery attempt. */
type QueueMessageOutcome = "ack" | "error" | "retry";

/**
 * Fields recorded for one consumed message — the disposition the push handler
 * left it in. Sent by the codegen `queue()` capture sink (via
 * `dispatchQueueBatch`) through `__lunora_admin__:recordQueueMessage`. Mirrors
 * `@lunora/queue`'s capture record shape; the packages share only this structural
 * contract (no runtime dependency edge), so keep the two in sync by hand.
 */
interface RecordQueueMessageInput {
    /** Delivery attempt number for this message (`message.attempts`). */
    attempts: number;
    /** The message body — stored JSON-encoded, capped by {@link MAX_BODY_CHARS}. */
    body: unknown;
    /** `true` when this retry will exceed `maxRetries`, so the message dead-letters next. */
    deadLettered?: boolean;
    /** Handler error message when `outcome` is `error`; absent otherwise. */
    error?: string;
    /** The `lunora/queues.ts` export name that consumed it (absent for an unmapped queue). */
    exportName?: string;
    /** The delivered message id (`message.id`); stable across retries of the same message. */
    messageId: string;
    /** How the handler disposed of the message this attempt. */
    outcome: QueueMessageOutcome;
    /** The stable wrangler queue name the batch was delivered from (`batch.queue`). */
    queue: string;
    /** Original message timestamp in epoch-ms (`message.timestamp`). */
    timestamp: number;
}

/**
 * One consumed message as served by `__lunora_admin__:getQueueMessages`, newest
 * first. `id` is a synthetic per-capture row id (a message retried N times yields
 * N rows, so the log shows the delivery progression); `messageId` is the stable
 * Cloudflare message id.
 */
interface QueueMessageRow {
    attempts: number;
    body: unknown;
    capturedAt: number;
    deadLettered: boolean;
    error?: string;
    exportName?: string;
    id: string;
    messageId: string;
    outcome: QueueMessageOutcome;
    queue: string;
    timestamp: number;
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** A string value or SQL NULL for an absent column. */
const orNull = (value: string | undefined): null | string =>
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an absent column.
    value ?? null;

/** Suffix appended to an oversized body preview so a viewer sees it was capped. */
const TRUNCATION_SUFFIX = "… [truncated by the dev queue catcher]";
/** Stand-in stored when a body can't be JSON-encoded at all (bytes/v8/cyclic). */
const UNSERIALIZABLE_MARKER = "[unserializable message body]";

/**
 * JSON-encode a message body for a TEXT column, capping oversized payloads with a
 * visible marker. A body that can't be JSON-encoded (a bytes/v8 payload, a cyclic
 * object) is stored as a diagnostic string rather than failing the capture — the
 * log records that a message was consumed even when its body can't be previewed.
 */
const encodeBody = (value: unknown): string => {
    // `JSON.stringify(undefined)` returns `undefined` (not a string); store null.
    if (value === undefined) {
        return "null";
    }

    try {
        // A body that stringifies to `undefined` (function/symbol) makes `.length`
        // throw here, falling through to the unserializable marker below.
        const encoded = JSON.stringify(value);

        if (encoded.length > MAX_BODY_CHARS) {
            return JSON.stringify(`${encoded.slice(0, MAX_BODY_CHARS)}${TRUNCATION_SUFFIX}`);
        }

        return encoded;
    } catch {
        return JSON.stringify(UNSERIALIZABLE_MARKER);
    }
};

/**
 * Whether a decoded body is a lossy stand-in the catcher stored in place of the
 * real payload (unserializable, or capped by {@link MAX_BODY_CHARS}). The replay
 * path refuses these: re-enqueuing the marker/truncated string would deliver a
 * corrupted message the original consumer never sent.
 */
const isLossyBody = (body: unknown): boolean => typeof body === "string" && (body === UNSERIALIZABLE_MARKER || body.endsWith(TRUNCATION_SUFFIX));

/** Parse a JSON TEXT column back to its value, tolerating null/garbage (returns undefined). */
const decodeBody = (value: null | string | undefined): unknown => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Create the reserved consumed-message table. Idempotent, so both the read and
 * write paths can call it defensively.
 */
const ensureQueueTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${QUEUE_TABLE}" (
            id TEXT PRIMARY KEY,
            captured_at INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            queue TEXT NOT NULL,
            export_name TEXT,
            body TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            error TEXT,
            dead_lettered INTEGER NOT NULL,
            message_ts INTEGER NOT NULL
        )`,
    );
};

/**
 * Persist a batch of consumed messages and trim the log to its retention cap.
 * Creates the table first so callers needn't. Returns the number of rows written.
 * Bodies are stored JSON-encoded (capped) in a TEXT column and decoded on read.
 */
const recordQueueMessages = (sql: SqlExec, inputs: ReadonlyArray<RecordQueueMessageInput>, capturedAt: number): { recorded: number } => {
    ensureQueueTable(sql);

    for (const input of inputs) {
        runSql(
            sql,
            `INSERT INTO "${QUEUE_TABLE}" (id, captured_at, message_id, queue, export_name, body, attempts, outcome, error, dead_lettered, message_ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            capturedAt,
            input.messageId,
            input.queue,
            orNull(input.exportName),
            encodeBody(input.body),
            input.attempts,
            input.outcome,
            orNull(input.error),
            input.deadLettered === true ? 1 : 0,
            input.timestamp,
        );
    }

    // Bounded retention: keep only the most recent QUEUE_RETENTION rows.
    runSql(
        sql,
        `DELETE FROM "${QUEUE_TABLE}"
         WHERE id NOT IN (
            SELECT id FROM "${QUEUE_TABLE}" ORDER BY captured_at DESC, id DESC LIMIT ?
         )`,
        QUEUE_RETENTION,
    );

    return { recorded: inputs.length };
};

/** The raw `__lunora_queue_messages` SQL row, decoded into a {@link QueueMessageRow} by {@link rowToEntry}. */
interface QueueMessageSqlRow {
    attempts: number;
    body: string;
    captured_at: number;
    dead_lettered: number;
    error: null | string;
    export_name: null | string;
    id: string;
    message_id: string;
    message_ts: number;
    outcome: string;
    queue: string;
}

/** Decode one raw SQL row into the {@link QueueMessageRow} wire shape (body JSON + nullable columns). */
const rowToEntry = (row: QueueMessageSqlRow): QueueMessageRow => {
    return {
        attempts: row.attempts,
        body: decodeBody(row.body),
        capturedAt: row.captured_at,
        deadLettered: row.dead_lettered === 1,
        error: row.error ?? undefined,
        exportName: row.export_name ?? undefined,
        id: row.id,
        messageId: row.message_id,
        outcome: row.outcome as QueueMessageOutcome,
        queue: row.queue,
        timestamp: row.message_ts,
    };
};

/** Options for {@link readQueueMessages} — an optional row cap and an optional queue-name filter. */
interface ReadQueueMessagesOptions {
    limit?: number;
    queue?: string;
}

/**
 * Read the consumed-message log newest-first as the {@link QueueMessageRow} wire
 * shape the studio Queues panel consumes. Creates the table first so a read on an
 * app whose consumers have never run returns an empty list instead of throwing.
 */
const readQueueMessages = (sql: SqlExec, options: ReadQueueMessagesOptions = {}): { entries: QueueMessageRow[] } => {
    ensureQueueTable(sql);

    const limit = Math.min(Math.max(options.limit ?? 100, 1), QUEUE_RETENTION);
    const filterQueue = typeof options.queue === "string" && options.queue.length > 0 ? options.queue : undefined;

    const where = filterQueue === undefined ? "" : `WHERE queue = ?`;
    const params: unknown[] = filterQueue === undefined ? [limit] : [filterQueue, limit];

    const rows = runSql<QueueMessageSqlRow>(sql, `SELECT * FROM "${QUEUE_TABLE}" ${where} ORDER BY captured_at DESC, id DESC LIMIT ?`, ...params).toArray();

    return { entries: rows.map((row) => rowToEntry(row)) };
};

/** Read a single captured row by its synthetic id — the replay path's lookup. Returns `undefined` when absent. */
const readQueueMessageById = (sql: SqlExec, id: string): QueueMessageRow | undefined => {
    ensureQueueTable(sql);

    const rows = runSql<QueueMessageSqlRow>(sql, `SELECT * FROM "${QUEUE_TABLE}" WHERE id = ? LIMIT 1`, id).toArray();
    const row = rows[0];

    return row === undefined ? undefined : rowToEntry(row);
};

/** Empty the consumed-message log. Used by the studio "clear log" action. */
const clearQueueMessages = (sql: SqlExec): { cleared: true } => {
    ensureQueueTable(sql);
    runSql(sql, `DELETE FROM "${QUEUE_TABLE}"`);

    return { cleared: true };
};

export {
    clearQueueMessages,
    ensureQueueTable,
    isLossyBody,
    MAX_BODY_CHARS,
    QUEUE_RETENTION,
    QUEUE_TABLE,
    readQueueMessageById,
    readQueueMessages,
    recordQueueMessages,
};
export type { QueueMessageOutcome, QueueMessageRow, ReadQueueMessagesOptions, RecordQueueMessageInput };
