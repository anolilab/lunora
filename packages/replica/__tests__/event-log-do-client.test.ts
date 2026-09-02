import { describe, expect, it } from "vitest";

import { defineMaterializer, MaterializerRuntime } from "../src/define-materializer";
import { EventLogDO } from "../src/event-log-do";
import { EventLogDOClient } from "../src/event-log-do-client";
import { InMemorySnapshotStore } from "../src/snapshot-store";

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

const createMockSql = () => {
    const tables = new Map<string, StoredRow[]>([["events", []]]);

    const sql = {
        exec(query: string, ...params: unknown[]): { toArray: () => StoredRow[] } {
            const upper = query.trim().toUpperCase();

            if (upper.startsWith("CREATE TABLE")) {
                const m = query.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
                if (m && !tables.has(m[1]!)) {
                    tables.set(m[1]!, []);
                }
                return { toArray: () => [] };
            }

            if (upper.startsWith("INSERT")) {
                const m = query.match(/INSERT\s+INTO\s+(\w+)/i);
                if (m) {
                    const table = tables.get(m[1]!);
                    if (table) {
                        table.push({
                            seq: params[0] as number,
                            type: params[1] as string,
                            payload: params[2] as string,
                            timestamp: params[3] as number,
                            client_id: (params[4] as string | null) ?? null,
                            session_id: (params[5] as string | null) ?? null,
                            parent_seq: (params[6] as number | null) ?? null,
                        });
                    }
                }
                return { toArray: () => [] };
            }

            if (upper.includes("COALESCE") && upper.includes("MAX(SEQ)")) {
                const table = tables.get("events") ?? [];
                const maxSeq = table.length > 0 ? Math.max(...table.map((r) => r.seq)) : -1;
                return { toArray: () => [{ next_seq: maxSeq + 1 } as unknown as StoredRow] };
            }

            if (upper.includes("COUNT(*)") && upper.includes("EVENTS")) {
                const table = tables.get("events") ?? [];
                return { toArray: () => [{ count: table.length } as unknown as StoredRow] };
            }

            if (upper.includes("FROM EVENTS")) {
                let table = [...(tables.get("events") ?? [])];

                const seqMatch = query.match(/WHERE\s+seq\s*>=\s*\?/i);
                if (seqMatch && params.length > 0) {
                    table = table.filter((r) => r.seq >= Number(params[0]));
                }

                // ORDER BY seq ASC — before the limit, as SQLite does.
                table.sort((a, b) => a.seq - b.seq);

                // LIMIT ? (bound — the handlers' form) or LIMIT <n>
                const limitMatch = query.match(/LIMIT\s+(\?|\d+)/i);
                if (limitMatch) {
                    table = table.slice(0, limitMatch[1] === "?" ? Number(params.at(-1)) : Number(limitMatch[1]));
                }

                return { toArray: () => table };
            }

            return { toArray: () => [] };
        },
    };

    return sql;
};

/** Create an EventLogDO instance backed by the in-memory mock SQL. */
const createDO = (): EventLogDO => {
    const sql = createMockSql();
    const state = { storage: { sql: sql as unknown as EventLogDO["state"]["storage"]["sql"] } };
    return new EventLogDO(state, {});
};

/** Wrap an EventLogDO as an EventLogDOClient by routing fetch through the DO. */
const createClient = (do_: EventLogDO): EventLogDOClient =>
    new EventLogDOClient({
        fetch: (req) => do_.fetch(req),
    });

// ── Tests ──────────────────────────────────────────────────────────────

describe("eventLogDOClient + MaterializerRuntime", () => {
    it("append events and read them back via getSince", async () => {
        expect.assertions(8);

        const do_ = createDO();
        const client = createClient(do_);

        const entries = await client.append([
            { type: "test.a", payload: { n: 1 } },
            { type: "test.b", payload: { n: 2 } },
        ]);

        expect(entries).toHaveLength(2);
        expect(entries[0]!.seq).toBe(0);
        expect(entries[0]!.type).toBe("test.a");
        expect(entries[1]!.seq).toBe(1);
        expect(entries[1]!.type).toBe("test.b");

        const since = await client.getSince(1);

        expect(since.entries).toHaveLength(1);
        expect(since.entries[0]!.seq).toBe(1);
        expect(since.entries[0]!.type).toBe("test.b");
    });

    it("paginates via getSince", async () => {
        expect.assertions(8);

        const do_ = createDO();
        const client = createClient(do_);

        await client.append([
            { type: "a", payload: {} },
            { type: "b", payload: {} },
            { type: "c", payload: {} },
        ]);

        const page1 = await client.getSince(0, 2);

        expect(page1.entries).toHaveLength(2);
        expect(page1.truncated).toBe(true);
        expect(page1.cursor).toBe(2);
        expect(page1.entries[0]!.seq).toBe(0);
        expect(page1.entries[1]!.seq).toBe(1);

        const page2 = await client.getSince(page1.cursor!, 2);

        expect(page2.entries).toHaveLength(1);
        expect(page2.truncated).toBe(false);
        expect(page2.entries[0]!.seq).toBe(2);
    });

    it("reports size", async () => {
        expect.assertions(2);

        const do_ = createDO();
        const client = createClient(do_);

        await expect(client.getSize()).resolves.toBe(0);

        await client.append([{ type: "x", payload: {} }]);

        await expect(client.getSize()).resolves.toBe(1);
    });

    it("returns full state", async () => {
        expect.assertions(2);

        const do_ = createDO();
        const client = createClient(do_);

        await client.append([
            { type: "x", payload: { v: 1 } },
            { type: "y", payload: { v: 2 } },
        ]);

        const state = await client.getState();

        expect(state.entries).toHaveLength(2);
        expect(state.nextSeq).toBe(2);
    });

    it("materializerRuntime.appendEvent persists through DO and applies to materializers", async () => {
        expect.assertions(4);

        const do_ = createDO();
        const client = createClient(do_);

        const counter = defineMaterializer({
            name: "counter",
            initial: () => {
                return { total: 0 };
            },
            handle: (state, entry) => {
                if (entry.type === "increment") {
                    return { total: state.total + 1 };
                }
                return state;
            },
        });

        const runtime = new MaterializerRuntime([counter], {
            doClient: client,
        });

        const entry = await runtime.appendEvent({ type: "increment", payload: {} });

        expect(entry.seq).toBe(0);
        expect(entry.type).toBe("increment");
        expect(counter.state).toEqual({ total: 1 });

        await runtime.appendEvent({ type: "increment", payload: {} });

        expect(counter.state).toEqual({ total: 2 });
    });

    it("materializerRuntime initialize recovers from DO and replays missed entries", async () => {
        expect.assertions(3);

        const do_ = createDO();
        const client = createClient(do_);

        // Pre-seed events in the DO before creating the runtime
        await client.append([
            { type: "increment", payload: {} },
            { type: "increment", payload: {} },
            { type: "increment", payload: {} },
        ]);

        const counter = defineMaterializer({
            name: "counter",
            initial: () => {
                return { total: 0 };
            },
            handle: (state, entry) => {
                if (entry.type === "increment") {
                    return { total: state.total + 1 };
                }
                return state;
            },
        });

        const runtime = new MaterializerRuntime([counter], {
            doClient: client,
        });

        // initialize should replay all 3 events from the DO
        const applied = await runtime.initialize();

        expect(applied).toBe(3);
        expect(counter.state).toEqual({ total: 3 });
        expect(runtime.appliedSeq).toBe(3);
    });

    it("materializerRuntime initialize is idempotent when called twice", async () => {
        expect.assertions(4);

        const do_ = createDO();
        const client = createClient(do_);

        await client.append([
            { type: "increment", payload: {} },
            { type: "increment", payload: {} },
        ]);

        const counter = defineMaterializer({
            name: "counter",
            initial: () => {
                return { total: 0 };
            },
            handle: (state, entry) => {
                if (entry.type === "increment") {
                    return { total: state.total + 1 };
                }
                return state;
            },
        });

        const runtime = new MaterializerRuntime([counter], {
            doClient: client,
        });

        await expect(runtime.initialize()).resolves.toBe(2);
        expect(counter.state).toEqual({ total: 2 });

        // Second initialize — should replay 0 new entries
        await expect(runtime.initialize()).resolves.toBe(0);
        expect(counter.state).toEqual({ total: 2 });
    });

    it("appendEvent throws when no doClient configured", async () => {
        expect.assertions(1);

        const counter = defineMaterializer({
            name: "counter",
            initial: () => {
                return { total: 0 };
            },
            handle: (state) => state,
        });

        const runtime = new MaterializerRuntime([counter]);

        await expect(runtime.appendEvent({ type: "x", payload: {} })).rejects.toThrow("requires a doClient");
    });

    // ── REPLICA-04: per-materializer catch-up watermark ─────────────────

    it("a fresh materializer alongside one snapshotted at seq 500 still catches up from the start", async () => {
        expect.assertions(3);

        const do_ = createDO();
        const client = createClient(do_);

        // Seed 501 events (seq 0..500) — enough to simulate a materializer
        // that has snapshotted far ahead of a sibling that has never run.
        await client.append(Array.from({ length: 501 }, () => ({ type: "increment", payload: {} })));

        const store = new InMemorySnapshotStore();

        // "veteran" has a snapshot at the highest seq — as if it recovered
        // long ago and persisted its state.
        await store.save("veteran", { appliedSeq: 500, state: 500 });
        // "fresh" has no snapshot at all — a materializer added later.

        const veteran = defineMaterializer({
            name: "veteran",
            initial: () => 0,
            handle: (state, entry) => (entry.type === "increment" ? state + 1 : state),
        });
        const fresh = defineMaterializer({
            name: "fresh",
            initial: () => 0,
            handle: (state, entry) => (entry.type === "increment" ? state + 1 : state),
        });

        const runtime = new MaterializerRuntime([veteran, fresh], {
            doClient: client,
            snapshotStore: store,
        });

        // Before the REPLICA-04 fix, the shared watermark would be bumped to
        // the MAX snapshot seq (500), so `getSince(500)` would only fetch the
        // last event — `fresh` would never see events 0..499 and would be
        // permanently stuck at `1` instead of `501`.
        const applied = await runtime.initialize();

        expect(applied).toBe(501);
        expect(fresh.state).toBe(501); // caught up on every event from seq 0
        expect(veteran.state).toBe(501); // 500 (snapshot) + the one event >= its own watermark
    });

    it("recovering from snapshots keeps a fresh materializer's watermark at 0 (not the sibling's)", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();

        await store.save("veteran", { appliedSeq: 500, state: 500 });

        const veteran = defineMaterializer({ name: "veteran", initial: () => 0, handle: (state) => state });
        const fresh = defineMaterializer({ name: "fresh", initial: () => 0, handle: (state) => state });

        const runtime = new MaterializerRuntime([veteran, fresh], { snapshotStore: store });

        await runtime.recoverFromSnapshots();

        // `appliedSeq` is the MINIMUM watermark across materializers — 0,
        // because `fresh` has no snapshot. A shared/MAX watermark would
        // report 500 here, which is exactly the REPLICA-04 bug.
        expect(runtime.appliedSeq).toBe(0);
    });
});
