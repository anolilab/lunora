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

// ── Types ──────────────────────────────────────────────────────────────

interface EventLogDOState {
    storage: {
        sql: {
            exec: (query: string, ...params: unknown[]) => unknown;
        };
    };
}

interface AppendRequest {
    events: {
        payload: unknown;
        timestamp?: number;
        type: string;
    }[];
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

        if (
            !Array.isArray(body.events) ||
            body.events.length === 0 ||
            body.events.some((eventRecord) => typeof eventRecord.type !== "string" || eventRecord.type.length === 0)
        ) {
            // Validate each event's `type` up front: it lands in a NOT NULL
            // column, so a malformed item would otherwise surface as a 500 via
            // the generic catch above instead of a clean 400.
            return Response.json(
                { error: { code: "BAD_REQUEST", message: "events[] with a non-empty string `type` required" } },
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        const entries: EventLogEntry[] = [];
        const { sql } = this.state.storage;
        const now = Date.now();

        for (const eventRecord of body.events) {
            const seq = EventLogDO.#nextSeq(sql);
            const entry: EventLogEntry = {
                seq,
                type: eventRecord.type,
                payload: eventRecord.payload,
                timestamp: eventRecord.timestamp ?? now,
            };
            EventLogDO.#insertEvent(sql, entry);
            entries.push(entry);
        }

        const response: AppendResponse = { entries };
        return Response.json(response, {
            status: 200,
            headers: { "content-type": "application/json" },
        });
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
        this.#initialized = true;
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
