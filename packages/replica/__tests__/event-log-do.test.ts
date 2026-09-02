import { describe, expect, it } from "vitest";

import { EventLogDO } from "../src/event-log-do";

// ── Mock SqlStorage ────────────────────────────────────────────────────

interface StoredRow {
    client_id: string | null;
    parent_seq: number | null;
    payload: string;
    seq: number;
    session_id: string | null;
    timestamp: number;
    type: string;
}

/** Body of a `GET /since` response. */
interface SincePage {
    cursor?: number;
    entries: { seq: number; type: string }[];
    truncated: boolean;
}

const createMockSql = () => {
    const tables = new Map<string, StoredRow[]>([["events", []]]);

    // Seed the events table

    const sql = {
        exec(query: string, ...params: unknown[]): { toArray: () => StoredRow[] } {
            const upper = query.trim().toUpperCase();

            // CREATE TABLE
            if (upper.startsWith("CREATE TABLE")) {
                const m = query.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
                if (m && !tables.has(m[1]!)) {
                    tables.set(m[1]!, []);
                }
                return { toArray: () => [] };
            }

            // INSERT
            if (upper.startsWith("INSERT")) {
                const m = query.match(/INSERT\s+INTO\s+(\w+)/i);
                if (m) {
                    const table = tables.get(m[1]!);
                    if (table) {
                        // params: [seq, type, payload, timestamp, client_id, session_id, parent_seq]
                        const row: StoredRow = {
                            seq: params[0] as number,
                            type: params[1] as string,
                            payload: params[2] as string,
                            timestamp: params[3] as number,
                            client_id: (params[4] as string | null) ?? null,
                            session_id: (params[5] as string | null) ?? null,
                            parent_seq: (params[6] as number | null) ?? null,
                        };
                        table.push(row);
                    }
                }
                return { toArray: () => [] };
            }

            // SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
            if (upper.includes("COALESCE") && upper.includes("MAX(SEQ)")) {
                const table = tables.get("events") ?? [];
                const maxSeq = table.length > 0 ? Math.max(...table.map((r) => r.seq)) : -1;
                const nextSeq = maxSeq + 1;
                return { toArray: () => [{ next_seq: nextSeq } as unknown as StoredRow] };
            }

            // SELECT COUNT(*) AS count
            if (upper.includes("COUNT(*)") && upper.includes("EVENTS")) {
                const table = tables.get("events") ?? [];
                return { toArray: () => [{ count: table.length } as unknown as StoredRow] };
            }

            // SELECT ... FROM events
            if (upper.includes("FROM EVENTS")) {
                let table = [...(tables.get("events") ?? [])];

                // WHERE seq >= ?
                const seqMatch = query.match(/WHERE\s+seq\s*>=\s*\?/i);
                if (seqMatch && params.length > 0) {
                    const since = Number(params[0]);
                    table = table.filter((r) => r.seq >= since);
                }

                // ORDER BY seq ASC — applied BEFORE the limit, as SQLite does.
                table.sort((a, b) => a.seq - b.seq);

                // LIMIT ? (bound — the handlers' form) or LIMIT <n>
                const limitMatch = query.match(/LIMIT\s+(\?|\d+)/i);
                if (limitMatch) {
                    const limit = limitMatch[1] === "?" ? Number(params.at(-1)) : Number(limitMatch[1]);
                    table = table.slice(0, limit);
                }

                return { toArray: () => table };
            }

            return { toArray: () => [] };
        },
    };

    return sql;
};

const createMockState = () => {
    const sql = createMockSql();

    return {
        storage: {
            sql: sql as unknown as EventLogDO["state"]["storage"]["sql"],
        },
    };
};

// ── Tests ──────────────────────────────────────────────────────────────

describe(EventLogDO, () => {
    const createDO = (): EventLogDO => {
        const state = createMockState();
        return new EventLogDO(state, {});
    };

    const doFetch = (do_: EventLogDO, method: string, path: string, body?: unknown): Promise<Response> => {
        const url = `http://localhost${path}`;
        const init: RequestInit & { headers: Record<string, string> } = {
            method,
            headers: { "content-type": "application/json" },
        };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }
        return do_.fetch(new Request(url, init));
    };

    it("returns empty state initially", async () => {
        expect.assertions(3);

        const do_ = createDO();
        const res = await doFetch(do_, "GET", "/state");

        expect(res.status).toBe(200);

        const data = (await res.json()) as { entries: unknown[]; nextSeq: number };

        expect(data.entries).toHaveLength(0);
        expect(data.nextSeq).toBe(0);
    });

    it("returns size 0 initially", async () => {
        expect.assertions(2);

        const do_ = createDO();
        const res = await doFetch(do_, "GET", "/size");

        expect(res.status).toBe(200);

        const data = (await res.json()) as { count: number };

        expect(data.count).toBe(0);
    });

    it("appends events and returns entries with seq numbers", async () => {
        expect.assertions(8);

        const do_ = createDO();
        const res = await doFetch(do_, "POST", "/append", {
            events: [
                { type: "test.event1", payload: { msg: "hello" } },
                { type: "test.event2", payload: { num: 42 } },
            ],
        });

        expect(res.status).toBe(200);

        const data = (await res.json()) as { entries: { payload: unknown; seq: number; type: string }[] };

        expect(data.entries).toHaveLength(2);
        expect(data.entries[0]!.seq).toBe(0);
        expect(data.entries[0]!.type).toBe("test.event1");
        expect(data.entries[0]!.payload).toEqual({ msg: "hello" });
        expect(data.entries[1]!.seq).toBe(1);
        expect(data.entries[1]!.type).toBe("test.event2");
        expect(data.entries[1]!.payload).toEqual({ num: 42 });
    });

    it("returns events since a given seq", async () => {
        expect.assertions(6);

        const do_ = createDO();

        // Append 3 events
        await doFetch(do_, "POST", "/append", {
            events: [
                { type: "e.1", payload: {} },
                { type: "e.2", payload: {} },
                { type: "e.3", payload: {} },
            ],
        });

        const res = await doFetch(do_, "GET", "/since?seq=1");

        expect(res.status).toBe(200);

        const data = (await res.json()) as { entries: { seq: number; type: string }[] };

        expect(data.entries).toHaveLength(2);
        expect(data.entries[0]!.seq).toBe(1);
        expect(data.entries[0]!.type).toBe("e.2");
        expect(data.entries[1]!.seq).toBe(2);
        expect(data.entries[1]!.type).toBe("e.3");
    });

    it("pages /since with an explicit limit", async () => {
        expect.assertions(12);

        const do_ = createDO();

        // Append 5 events
        await doFetch(do_, "POST", "/append", {
            events: [
                { type: "e.1", payload: {} },
                { type: "e.2", payload: {} },
                { type: "e.3", payload: {} },
                { type: "e.4", payload: {} },
                { type: "e.5", payload: {} },
            ],
        });

        // Get first page of 2
        const page1 = await doFetch(do_, "GET", "/since?seq=0&limit=2");
        const d1 = (await page1.json()) as SincePage;

        expect(d1.entries).toHaveLength(2);
        expect(d1.entries[0]!.seq).toBe(0);
        expect(d1.entries[1]!.seq).toBe(1);
        expect(d1.truncated).toBe(true);
        expect(d1.cursor).toBe(2);

        // Get second page from the cursor the first one handed back
        const page2 = await doFetch(do_, "GET", `/since?seq=${String(d1.cursor)}&limit=2`);
        const d2 = (await page2.json()) as SincePage;

        expect(d2.entries).toHaveLength(2);
        expect(d2.entries[0]!.seq).toBe(2);
        expect(d2.truncated).toBe(true);
        expect(d2.cursor).toBe(4);

        // Last page — one entry, and the walk ends here.
        const page3 = await doFetch(do_, "GET", `/since?seq=${String(d2.cursor)}&limit=2`);
        const d3 = (await page3.json()) as SincePage;

        expect(d3.entries).toHaveLength(1);
        expect(d3.entries[0]!.seq).toBe(4);
        expect(d3.truncated).toBe(false);
    });

    it("bounds /since to 500 entries when no limit is given", async () => {
        expect.assertions(4);

        const do_ = createDO();

        await doFetch(do_, "POST", "/append", {
            events: Array.from({ length: 501 }, () => {
                return { type: "e", payload: {} };
            }),
        });

        // A catch-up from 0 must NOT serialize the whole log into one response.
        const page1 = await doFetch(do_, "GET", "/since?seq=0");
        const d1 = (await page1.json()) as SincePage;

        expect(d1.entries).toHaveLength(500);
        expect(d1.truncated).toBe(true);
        expect(d1.cursor).toBe(500);

        const page2 = await doFetch(do_, "GET", `/since?seq=${String(d1.cursor)}`);
        const d2 = (await page2.json()) as SincePage;

        expect(d2.entries).toHaveLength(1);
    });

    it("rejects an out-of-range /since limit", async () => {
        expect.assertions(2);

        const do_ = createDO();

        await expect(doFetch(do_, "GET", "/since?seq=0&limit=0").then((r) => r.status)).resolves.toBe(400);
        await expect(doFetch(do_, "GET", "/since?seq=0&limit=1001").then((r) => r.status)).resolves.toBe(400);
    });

    it("rejects non-integral /since pagination parameters", async () => {
        expect.assertions(2);

        const do_ = createDO();

        // Both are finite, so the old range checks let them through: a fractional
        // `limit` reaches SQLite's `LIMIT ?` as a 500, and a fractional `seq`
        // silently shifts the `seq >= ?` boundary past a real entry.
        await expect(doFetch(do_, "GET", "/since?seq=0&limit=1.5").then((r) => r.status)).resolves.toBe(400);
        await expect(doFetch(do_, "GET", "/since?seq=1.5").then((r) => r.status)).resolves.toBe(400);
    });

    it("rejects append with empty events array", async () => {
        expect.assertions(1);

        const do_ = createDO();
        const res = await doFetch(do_, "POST", "/append", { events: [] });

        expect(res.status).toBe(400);
    });

    it("rejects append with missing events field", async () => {
        expect.assertions(1);

        const do_ = createDO();
        const res = await doFetch(do_, "POST", "/append", {});

        expect(res.status).toBe(400);
    });

    it("rejects unknown routes with 404", async () => {
        expect.assertions(1);

        const do_ = createDO();
        const res = await doFetch(do_, "GET", "/unknown");

        expect(res.status).toBe(404);
    });

    it("returns state with entries and nextSeq after appends", async () => {
        expect.assertions(2);

        const do_ = createDO();

        await doFetch(do_, "POST", "/append", {
            events: [
                { type: "t.1", payload: { x: 1 } },
                { type: "t.2", payload: { x: 2 } },
            ],
        });

        const res = await doFetch(do_, "GET", "/state");
        const data = (await res.json()) as { entries: { seq: number }[]; nextSeq: number };

        expect(data.entries).toHaveLength(2);
        expect(data.nextSeq).toBe(2);
    });

    it("handles custom timestamps", async () => {
        expect.assertions(1);

        const do_ = createDO();
        const ts = 1_234_567_890;

        const res = await doFetch(do_, "POST", "/append", {
            events: [{ type: "t.1", payload: { v: 1 }, timestamp: ts }],
        });

        const data = (await res.json()) as { entries: { timestamp: number }[] };

        expect(data.entries[0]!.timestamp).toBe(ts);
    });

    // ── REPLICA-02: clientId/sessionId/parentSeqNum ────────────────────

    it("round-trips clientId/sessionId/parentSeqNum through /append (REPLICA-02)", async () => {
        expect.assertions(7);

        const do_ = createDO();

        const res = await doFetch(do_, "POST", "/append", {
            events: [{ type: "t.1", payload: { v: 1 }, clientId: "client-1", sessionId: "session-1", parentSeqNum: 3 }],
        });

        expect(res.status).toBe(200);

        const data = (await res.json()) as {
            entries: { clientId?: string; parentSeqNum?: number; sessionId?: string }[];
        };

        // Previously always NULL — the fix threads these through `entry`.
        expect(data.entries[0]!.clientId).toBe("client-1");
        expect(data.entries[0]!.sessionId).toBe("session-1");
        expect(data.entries[0]!.parentSeqNum).toBe(3);

        // And they persist — a fresh read (not just the append response) sees them too.
        const stateRes = await doFetch(do_, "GET", "/state");
        const stateData = (await stateRes.json()) as {
            entries: { clientId?: string; parentSeqNum?: number; sessionId?: string }[];
        };

        expect(stateData.entries[0]!.clientId).toBe("client-1");
        expect(stateData.entries[0]!.sessionId).toBe("session-1");
        expect(stateData.entries[0]!.parentSeqNum).toBe(3);
    });

    it("rejects a non-finite timestamp instead of trusting it into the INTEGER column", async () => {
        expect.assertions(1);

        const do_ = createDO();

        const res = await doFetch(do_, "POST", "/append", {
            events: [{ type: "t.1", payload: {}, timestamp: Number.NaN }],
        });

        expect(res.status).toBe(400);
    });

    it("rejects a negative or non-integer parentSeqNum", async () => {
        expect.assertions(2);

        const do_ = createDO();

        const negative = await doFetch(do_, "POST", "/append", {
            events: [{ type: "t.1", payload: {}, parentSeqNum: -1 }],
        });
        const nonInteger = await doFetch(do_, "POST", "/append", {
            events: [{ type: "t.1", payload: {}, parentSeqNum: 1.5 }],
        });

        expect(negative.status).toBe(400);
        expect(nonInteger.status).toBe(400);
    });
});
