/**
 * EventLogDO — a Durable Object that persists an append-only event log
 * in SQLite and exposes an HTTP RPC surface for append / replay / snapshots.
 *
 * Used by `@lunora/replica` materializers on the server side: the materializer
 * runtime calls `append()` to record events and `getSince()` to catch up after
 * a restart or snapshot recovery.
 *
 * ## RPC surface (fetch-like)
 *
 * | Method | Path               | Description                          |
 * |--------|--------------------|--------------------------------------|
 * | POST   | `/append`          | Insert events, return assigned seqs  |
 * | GET    | `/since?seq=N`     | Events with `seq >= N`               |
 * | GET    | `/range?from=N&amp;limit=M` | Paginated read               |
 * | GET    | `/size`            | Number of stored events              |
 * | GET    | `/state`           | Full event log state (for recovery)  |
 */

import type { EventLogEntry } from "./event-log";

// ── Idempotency fingerprint ─────────────────────────────────────────────

/**
 * Marks an `Error` as an idempotency conflict: a retried `/append` reused a
 * `batchId` whose persisted fingerprint doesn't match the incoming request —
 * i.e. the caller reused an idempotency key for a DIFFERENT event batch.
 * Caught in `#handleAppend` and surfaced as an HTTP 409, instead of silently
 * dropping the new events and returning the unrelated originally-persisted
 * entries.
 *
 * A tagged plain `Error` (not a subclass) — `EventLogDO` is the file's only
 * class; a second `class IdempotencyConflictError` would trip
 * `max-classes-per-file`.
 */
const IDEMPOTENCY_CONFLICT: unique symbol = Symbol("lunora.replica.event-log-do.idempotency-conflict");

const createIdempotencyConflictError = (message: string): Error => {
    const error = new Error(message);

    Object.defineProperty(error, IDEMPOTENCY_CONFLICT, { value: true });

    return error;
};

const isIdempotencyConflictError = (error: unknown): error is Error => error instanceof Error && IDEMPOTENCY_CONFLICT in error;

/**
 * Recursively canonicalize a JSON-serialisable value so structurally
 * identical data always encodes identically regardless of object-key
 * insertion order at ANY nesting depth. Arrays keep their order — only
 * object keys are sorted.
 */
const canonicalizeForFingerprint = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeForFingerprint(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
        const result: Record<string, unknown> = {};

        for (const key of sortedKeys) {
            result[key] = canonicalizeForFingerprint(record[key]);
        }

        return result;
    }

    return value;
};

/**
 * Deterministic SHA-256 fingerprint (hex) of a batch's ORIGINAL request
 * contents — binds an idempotency key to what was actually sent, so
 * reusing `batchId` with a different event batch is detected instead of
 * silently returning unrelated, previously-persisted entries.
 */
const fingerprintBatch = async (events: AppendRequestEvent[]): Promise<string> => {
    const canonical = JSON.stringify(canonicalizeForFingerprint(events));
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// ── Types ──────────────────────────────────────────────────────────────

interface EventLogDOState {
    storage: {
        sql: {
            exec: (query: string, ...params: unknown[]) => unknown;
        };

        /**
         * The DO platform's native atomic-transaction primitive (async;
         * commits on resolve, rolls back on throw/reject). Test doubles that
         * omit it fall back to a bare (non-transactional) call — see
         * `#handleAppend`.
         */
        transaction?: <T>(closure: () => Promise<T> | T) => Promise<T>;
    };
}

interface AppendRequestEvent {
    /** Globally-unique client identifier (for offline/optimistic attribution). */
    clientId?: string;
    /** Causal parent sequence number — must be a non-negative integer. */
    parentSeqNum?: number;
    payload: unknown;
    /** Session identifier within the client. */
    sessionId?: string;
    timestamp?: number;
    type: string;
}

interface AppendRequest {
    /**
     * Optional idempotency key for the whole batch. A retried `/append` with
     * the same `batchId` returns the originally-persisted entries instead of
     * inserting duplicates — see `#handleAppend`.
     */
    batchId?: string;
    events: AppendRequestEvent[];
}

interface AppendResponse {
    entries: EventLogEntry[];
}

interface RangeResponse {
    entries: EventLogEntry[];
    hasMore: boolean;
}

interface SqlRow {
    [key: string]: unknown;
    client_id: string | null;
    parent_seq: number | null;
    payload: string;
    seq: number;
    session_id: string | null;
    timestamp: number;
    type: string;
}

interface SqlCursor {
    [Symbol.iterator]?: () => Iterator<SqlRow>;
    toArray?: () => SqlRow[];
}

// ── Cursor helpers ─────────────────────────────────────────────────────

const toArray = (cursor: SqlCursor): SqlRow[] => {
    if (typeof cursor.toArray === "function") {
        return cursor.toArray();
    }
    if (typeof cursor[Symbol.iterator] === "function") {
        return [...(cursor as Iterable<SqlRow>)];
    }
    return [];
};

/** Map raw SQL cursor rows into the public EventLogEntry shape. */
const rowsToEntries = (cursor: SqlCursor): EventLogEntry[] => {
    const rows = toArray(cursor);
    return rows.map((row) => {
        return {
            seq: row.seq,
            type: row.type,
            payload: JSON.parse(row.payload) as unknown,
            timestamp: row.timestamp,
            clientId: row.client_id ?? undefined,
            sessionId: row.session_id ?? undefined,
            parentSeqNum: row.parent_seq ?? undefined,
        };
    });
};

// ── DO Class ───────────────────────────────────────────────────────────

/**
 * `EventLogDO` is part of the experimental `@lunora/replica` API and may change without a major version bump.
 * @experimental
 */
export class EventLogDO {
    protected state: EventLogDOState;
    protected env: unknown;
    /** Whether the `events` table has been created. */
    #initialized = false;

    public constructor(state: EventLogDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    // ── Fetch (RPC dispatch) ──────────────────────────────────────────

    public async fetch(request: Request): Promise<Response> {
        this.#ensureTable();

        const url = new URL(request.url);

        try {
            if (request.method === "POST" && url.pathname === "/append") {
                return await this.#handleAppend(request);
            }
            if (request.method === "GET" && url.pathname === "/since") {
                return this.#handleSince(url);
            }
            if (request.method === "GET" && url.pathname === "/range") {
                return this.#handleRange(url);
            }
            if (request.method === "GET" && url.pathname === "/size") {
                return this.#handleSize();
            }
            if (request.method === "GET" && url.pathname === "/state") {
                return this.#handleState();
            }
        } catch (error) {
            // Log server-side, but return a generic message — echoing
            // `error.message` (or a stringified error) back to the caller can
            // leak stack-trace / internal detail (CodeQL: information exposure).
            console.error("[event-log-do] request failed:", error);

            return Response.json(
                {
                    error: {
                        code: "INTERNAL_ERROR",
                        message: "internal error",
                    },
                },
                { status: 500, headers: { "content-type": "application/json" } },
            );
        }

        return Response.json(
            { error: { code: "NOT_FOUND", message: "unknown route" } },
            {
                status: 404,
                headers: { "content-type": "application/json" },
            },
        );
    }

    // ── Handlers ──────────────────────────────────────────────────────

    /** POST /append — insert events, return entries with assigned seqs. */
    async #handleAppend(request: Request): Promise<Response> {
        let body: AppendRequest;

        try {
            body = (await request.json()) as AppendRequest;
        } catch {
            return Response.json(
                { error: { code: "BAD_REQUEST", message: "invalid JSON body" } },
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        const validationError = EventLogDO.#validateAppendRequest(body);

        if (validationError) {
            return Response.json(
                { error: { code: "BAD_REQUEST", message: validationError } },
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        const { sql } = this.state.storage;
        const { batchId } = body;
        const runBatch = (): Promise<EventLogEntry[]> => EventLogDO.#runAppendBatch(sql, body, batchId);

        // Run the whole batch (lookup + inserts) inside the DO's native
        // transaction primitive so a mid-batch failure persists nothing —
        // the caller sees a 500 and can safely retry the whole batch (which,
        // with a `batchId`, is now also idempotent). Test doubles whose
        // storage lacks `transaction` fall back to a bare call — their fakes
        // carry no transactional semantics anyway (see ShardDO.runInTransaction
        // in `@lunora/do` for the same convention).
        const { transaction } = this.state.storage;
        let entries: EventLogEntry[];

        try {
            entries = typeof transaction === "function" ? await transaction(runBatch) : await runBatch();
        } catch (error) {
            if (isIdempotencyConflictError(error)) {
                return Response.json(
                    { error: { code: "CONFLICT", message: error.message } },
                    { status: 409, headers: { "content-type": "application/json" } },
                );
            }

            throw error;
        }

        const response: AppendResponse = { entries };
        return Response.json(response, {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    /**
     * Execute one `/append` batch: idempotent lookup (fingerprint-checked) or
     * insert + record. Extracted out of `#handleAppend` (which only wires up
     * the HTTP request/response and the transaction wrapper) to keep that
     * method's cognitive complexity within budget.
     *
     * Idempotent replay: a batch already persisted under `batchId` returns
     * the originally-persisted entries instead of inserting a duplicate copy
     * — but ONLY when the incoming request's fingerprint matches what was
     * persisted under that key. A `batchId` reused for a genuinely different
     * event batch throws an idempotency-conflict error instead of silently
     * dropping the new events and returning unrelated entries.
     */
    static async #runAppendBatch(
        sql: { exec: (query: string, ...params: unknown[]) => unknown },
        body: AppendRequest,
        batchId: string | undefined,
    ): Promise<EventLogEntry[]> {
        let fingerprint: string | undefined;

        if (typeof batchId === "string") {
            fingerprint = await fingerprintBatch(body.events);

            const existing = EventLogDO.#findBatch(sql, batchId);

            if (existing) {
                if (existing.fingerprint !== fingerprint) {
                    throw createIdempotencyConflictError(`batchId "${batchId}" was already used for a different event batch`);
                }

                return existing.entries;
            }
        }

        const now = Date.now();
        const entries: EventLogEntry[] = [];

        for (const eventRecord of body.events) {
            const seq = EventLogDO.#nextSeq(sql);
            const entry: EventLogEntry = {
                seq,
                type: eventRecord.type,
                payload: eventRecord.payload,
                timestamp: eventRecord.timestamp ?? now,
                clientId: eventRecord.clientId,
                sessionId: eventRecord.sessionId,
                parentSeqNum: eventRecord.parentSeqNum,
            };
            EventLogDO.#insertEvent(sql, entry);
            entries.push(entry);
        }

        if (typeof batchId === "string" && fingerprint !== undefined) {
            const firstSeq = entries[0]?.seq;
            const lastSeq = entries.at(-1)?.seq;

            if (firstSeq !== undefined && lastSeq !== undefined) {
                EventLogDO.#recordBatch(sql, batchId, firstSeq, lastSeq, fingerprint);
            }
        }

        return entries;
    }

    /**
     * Validate an `/append` request body up front so malformed input surfaces
     * as a clean 400 instead of a 500 from the generic catch handler (e.g. a
     * non-string `type` or a non-finite `timestamp` landing in a NOT NULL /
     * INTEGER column).
     * @returns An error message, or `undefined` when the body is valid.
     */
    static #validateAppendRequest(body: AppendRequest): string | undefined {
        if (!Array.isArray(body.events) || body.events.length === 0) {
            return "events[] with a non-empty string `type` required";
        }

        if (body.batchId !== undefined && (typeof body.batchId !== "string" || body.batchId.length === 0)) {
            return "batchId must be a non-empty string";
        }

        for (const eventRecord of body.events) {
            const error = EventLogDO.#validateEventRecord(eventRecord);

            if (error !== undefined) {
                return error;
            }
        }

        return undefined;
    }

    /**
     * Validate a single `/append` event record — split out of
     * {@link EventLogDO.#validateAppendRequest} to keep each function's
     * cognitive complexity down.
     * @returns An error message, or `undefined` when the record is valid.
     */
    static #validateEventRecord(eventRecord: AppendRequestEvent): string | undefined {
        if (typeof eventRecord.type !== "string" || eventRecord.type.length === 0) {
            return "events[] with a non-empty string `type` required";
        }

        if (eventRecord.timestamp !== undefined && !Number.isFinite(eventRecord.timestamp)) {
            return "events[].timestamp must be a finite number";
        }

        if (eventRecord.clientId !== undefined && typeof eventRecord.clientId !== "string") {
            return "events[].clientId must be a string";
        }

        if (eventRecord.sessionId !== undefined && typeof eventRecord.sessionId !== "string") {
            return "events[].sessionId must be a string";
        }

        if (
            eventRecord.parentSeqNum !== undefined &&
            (typeof eventRecord.parentSeqNum !== "number" || !Number.isInteger(eventRecord.parentSeqNum) || eventRecord.parentSeqNum < 0)
        ) {
            return "events[].parentSeqNum must be a non-negative integer";
        }

        return undefined;
    }

    /** GET /since?seq=N — return entries with seq >= N. */
    #handleSince(url: URL): Response {
        const seqParameter = url.searchParams.get("seq");
        const sinceSeq = seqParameter === null ? 0 : Number(seqParameter);

        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
            return Response.json(
                { error: { code: "BAD_REQUEST", message: "invalid seq" } },
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        const { sql } = this.state.storage;
        const cursor = sql.exec(
            "SELECT seq, type, payload, timestamp, client_id, session_id, parent_seq FROM events WHERE seq >= ? ORDER BY seq ASC",
            sinceSeq,
        ) as SqlCursor;

        const entries = rowsToEntries(cursor);

        return Response.json(
            { entries },
            {
                status: 200,
                headers: { "content-type": "application/json" },
            },
        );
    }

    /** GET /range?from=N&amp;limit=M — paginated read (default limit 50). */
    #handleRange(url: URL): Response {
        const fromParameter = url.searchParams.get("from");
        const fromSeq = fromParameter === null ? 0 : Number(fromParameter);
        const limitParameter = url.searchParams.get("limit");
        const limit = limitParameter === null ? 50 : Number(limitParameter);

        if (!Number.isFinite(fromSeq) || fromSeq < 0 || !Number.isFinite(limit) || limit < 1 || limit > 1000) {
            return Response.json(
                { error: { code: "BAD_REQUEST", message: "invalid from/limit" } },
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        const { sql } = this.state.storage;
        const cursor = sql.exec(
            "SELECT seq, type, payload, timestamp, client_id, session_id, parent_seq FROM events WHERE seq >= ? ORDER BY seq ASC LIMIT ?",
            fromSeq,
            limit + 1, // Fetch one extra to detect hasMore
        ) as SqlCursor;

        const allRows = rowsToEntries(cursor);
        const hasMore = allRows.length > limit;
        const entries = hasMore ? allRows.slice(0, limit) : allRows;

        const response: RangeResponse = { entries, hasMore };
        return Response.json(response, {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    /** GET /size — return the number of stored events. */
    #handleSize(): Response {
        const { sql } = this.state.storage;
        const cursor = sql.exec("SELECT COUNT(*) AS count FROM events") as SqlCursor;

        const rows = toArray(cursor);
        const count = (rows[0] as { count: number } | undefined)?.count ?? 0;

        return Response.json(
            { count },
            {
                status: 200,
                headers: { "content-type": "application/json" },
            },
        );
    }

    /** GET /state — return the full event log state. */
    #handleState(): Response {
        const { sql } = this.state.storage;

        const cursor = sql.exec("SELECT seq, type, payload, timestamp, client_id, session_id, parent_seq FROM events ORDER BY seq ASC") as SqlCursor;

        const entries = rowsToEntries(cursor);

        const nextSeq = (entries.at(-1)?.seq ?? -1) + 1;

        return Response.json({ entries, nextSeq }, { status: 200, headers: { "content-type": "application/json" } });
    }

    // ── Internal ──────────────────────────────────────────────────────

    #ensureTable(): void {
        if (this.#initialized) {
            return;
        }
        const { sql } = this.state.storage;
        sql.exec(
            "CREATE TABLE IF NOT EXISTS events (" +
                "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "type TEXT NOT NULL, " +
                "payload TEXT NOT NULL, " +
                "timestamp INTEGER NOT NULL, " +
                "client_id TEXT, " +
                "session_id TEXT, " +
                "parent_seq INTEGER" +
                ")",
        );
        // Idempotency ledger for `/append`'s optional `batchId`: one row per
        // batch, `batch_id` UNIQUE so a concurrent double-insert of the same
        // batch (belt-and-suspenders alongside the `#findBatch` pre-check
        // inside the same transaction) fails loudly instead of duplicating.
        // `fingerprint` binds the key to the ORIGINAL request contents so a
        // reused `batchId` with different events is detected as a conflict
        // instead of silently returning the earlier, unrelated batch.
        sql.exec(
            "CREATE TABLE IF NOT EXISTS event_batches (" +
                "batch_id TEXT PRIMARY KEY, " +
                "first_seq INTEGER NOT NULL, " +
                "last_seq INTEGER NOT NULL, " +
                "fingerprint TEXT NOT NULL" +
                ")",
        );
        this.#initialized = true;
    }

    /** Look up a previously-persisted batch by its idempotency key. */
    static #findBatch(
        sql: { exec: (query: string, ...params: unknown[]) => unknown },
        batchId: string,
    ): { entries: EventLogEntry[]; fingerprint: string } | undefined {
        const batchCursor = sql.exec("SELECT first_seq, last_seq, fingerprint FROM event_batches WHERE batch_id = ?", batchId) as SqlCursor;
        const batchRows = toArray(batchCursor);
        const batchRow = batchRows[0] as { fingerprint: string; first_seq: number; last_seq: number } | undefined;

        if (!batchRow) {
            return undefined;
        }

        const cursor = sql.exec(
            "SELECT seq, type, payload, timestamp, client_id, session_id, parent_seq FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq ASC",
            batchRow.first_seq,
            batchRow.last_seq,
        ) as SqlCursor;

        return { entries: rowsToEntries(cursor), fingerprint: batchRow.fingerprint };
    }

    /** Record a persisted batch's seq range and request fingerprint under its idempotency key. */
    static #recordBatch(
        sql: { exec: (query: string, ...params: unknown[]) => unknown },
        batchId: string,
        firstSeq: number,
        lastSeq: number,
        fingerprint: string,
    ): void {
        sql.exec(
            "INSERT INTO event_batches (batch_id, first_seq, last_seq, fingerprint) VALUES (?, ?, ?, ?)",
            batchId,
            firstSeq,
            lastSeq,
            fingerprint,
        );
    }

    /** Get the next available sequence number. */
    static #nextSeq(sql: { exec: (query: string, ...params: unknown[]) => unknown }): number {
        const cursor = sql.exec("SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events") as SqlCursor;

        const rows = toArray(cursor);
        return (rows[0] as { next_seq: number } | undefined)?.next_seq ?? 0;
    }

    /** Insert a single event entry. */
    /* eslint-disable unicorn/no-null -- SQLite bindings use `null` for missing optional columns */
    static #insertEvent(sql: { exec: (query: string, ...params: unknown[]) => unknown }, entry: EventLogEntry): void {
        let parentSeq: number | null = null;

        if (typeof entry.parentSeqNum === "number") {
            parentSeq = entry.parentSeqNum;
        }

        sql.exec(
            "INSERT INTO events (seq, type, payload, timestamp, client_id, session_id, parent_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
            entry.seq,
            entry.type,
            JSON.stringify(entry.payload),
            entry.timestamp,
            entry.clientId ?? null,
            entry.sessionId ?? null,
            parentSeq,
        );
    }
    /* eslint-enable unicorn/no-null */
}
