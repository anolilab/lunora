import { describe, expect, it } from "vitest";

import { EventLogDO } from "../src/event-log-do";
import { EventLogDOClient } from "../src/event-log-do-client";
import { signedRequest, TEST_ENV, TEST_INSTANCE } from "./_helpers/signed-request";

// ── Mock SqlStorage with a REAL (rollback-on-throw) transaction ────────
//
// Unlike the plain mocks in `event-log-do.test.ts`, this double models the
// DO platform's native `storage.transaction()` primitive closely enough to
// prove `#handleAppend`'s atomicity claim: writes made during a closure that
// throws are rolled back, not just left uncommitted in a real SQLite engine.

interface StoredBatchRow {
    batch_id: string;
    fingerprint: string;
    first_seq: number;
    last_seq: number;
}

interface StoredEventRow {
    client_id: string | null;
    parent_seq: number | null;
    payload: string;
    seq: number;
    session_id: string | null;
    timestamp: number;
    type: string;
}

/** A payload containing this marker makes the mock's INSERT throw — simulates a mid-batch write failure. */
const FAIL_MARKER = "__FAIL__";

/** The three `SELECT … FROM events` shapes the mock recognises. */
const SEQ_RANGE = /WHERE\s+seq\s*>=\s*\?\s+AND\s+seq\s*<=\s*\?/i;
const SEQ_SINCE = /WHERE\s+seq\s*>=\s*\?/i;
const SEQ_LIMIT = /LIMIT\s+(\d+)/i;

const createMockState = (): EventLogDO["state"] => {
    let events: StoredEventRow[] = [];
    let batches: StoredBatchRow[] = [];

    const exec = (query: string, ...params: unknown[]): { toArray: () => unknown[] } => {
        const upper = query.trim().toUpperCase();

        if (upper.startsWith("CREATE TABLE")) {
            return { toArray: () => [] };
        }

        if (upper.includes("INSERT INTO EVENT_BATCHES")) {
            batches.push({
                batch_id: params[0] as string,
                first_seq: params[1] as number,
                last_seq: params[2] as number,
                fingerprint: params[3] as string,
            });

            return { toArray: () => [] };
        }

        if (upper.includes("INSERT INTO EVENTS")) {
            const payload = params[2] as string;

            if (payload.includes(FAIL_MARKER)) {
                throw new Error("simulated mid-batch write failure");
            }

            events.push({
                seq: params[0] as number,
                type: params[1] as string,
                payload,
                timestamp: params[3] as number,
                client_id: (params[4] as string | null) ?? null,
                session_id: (params[5] as string | null) ?? null,
                parent_seq: (params[6] as number | null) ?? null,
            });

            return { toArray: () => [] };
        }

        if (upper.includes("COALESCE") && upper.includes("MAX(SEQ)")) {
            const maxSeq = events.length > 0 ? Math.max(...events.map((r) => r.seq)) : -1;

            return { toArray: () => [{ next_seq: maxSeq + 1 }] };
        }

        if (upper.includes("COUNT(*)") && upper.includes("EVENTS")) {
            return { toArray: () => [{ count: events.length }] };
        }

        if (upper.includes("FROM EVENT_BATCHES")) {
            const batchId = params[0] as string;
            const row = batches.find((b) => b.batch_id === batchId);

            return { toArray: () => (row ? [row] : []) };
        }

        if (upper.includes("FROM EVENTS")) {
            // Both recognised WHERE shapes are the same bounded filter — a range
            // names both ends, a `>= ?` names only the lower one — so pick the
            // bounds and filter once. An unrecognised query stays unbounded.
            const isRange = SEQ_RANGE.test(query);
            const isSince = !isRange && SEQ_SINCE.test(query) && params.length > 0;
            const from = isRange || isSince ? Number(params[0]) : Number.NEGATIVE_INFINITY;
            const to = isRange ? Number(params[1]) : Number.POSITIVE_INFINITY;

            let rows = events.filter((r) => r.seq >= from && r.seq <= to);

            const limitMatch = SEQ_LIMIT.exec(query);

            if (limitMatch) {
                rows = rows.slice(0, Number(limitMatch[1]));
            }

            rows.sort((a, b) => a.seq - b.seq);

            return { toArray: () => rows };
        }

        return { toArray: () => [] };
    };

    const transaction = async <T>(closure: () => Promise<T> | T): Promise<T> => {
        // Snapshot both tables before running the closure; on throw, restore
        // them so nothing the closure wrote survives — a true rollback.
        const eventsSnapshot = [...events];
        const batchesSnapshot = [...batches];

        try {
            return await closure();
        } catch (error) {
            events = eventsSnapshot;
            batches = batchesSnapshot;

            throw error;
        }
    };

    return {
        id: { toString: () => TEST_INSTANCE },
        storage: {
            sql: { exec },
            transaction,
        },
    };
};

const doFetch = async (do_: EventLogDO, method: string, path: string, body?: unknown): Promise<Response> =>
    do_.fetch(await signedRequest(method, `http://localhost${path}`, body === undefined ? "" : JSON.stringify(body)));

// ── Tests ──────────────────────────────────────────────────────────────

describe("eventLogDO /append — atomicity + idempotency (REPLICA-03)", () => {
    it("a mid-batch write failure persists nothing (all-or-nothing)", async () => {
        expect.assertions(2);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        const res = await doFetch(do_, "POST", "/append", {
            batchId: "batch-mid-failure",
            events: [
                { type: "a", payload: { ok: true } },
                { type: "b", payload: { poison: FAIL_MARKER } },
                { type: "c", payload: { ok: true } },
            ],
        });

        expect(res.status).toBe(500);

        const sizeRes = await doFetch(do_, "GET", "/size");
        const size = (await sizeRes.json()) as { count: number };

        // Without the transaction wrapper, event "a" would have been
        // persisted before "b" threw — a partial batch. The fix rolls the
        // whole batch back.
        expect(size.count).toBe(0);
    });

    it("a retried batch with the same batchId returns the original entries without duplicating", async () => {
        expect.assertions(5);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        const body = {
            batchId: "batch-1",
            events: [
                { type: "x", payload: { n: 1 } },
                { type: "y", payload: { n: 2 } },
            ],
        };

        const first = await doFetch(do_, "POST", "/append", body);

        expect(first.status).toBe(200);

        const firstData = (await first.json()) as { entries: { payload: unknown; seq: number; type: string }[] };

        expect(firstData.entries).toHaveLength(2);

        // Simulate the caller not seeing the response (e.g. a network
        // timeout that hid a successful append) and retrying the identical
        // batch under the same idempotency key.
        const retry = await doFetch(do_, "POST", "/append", body);

        expect(retry.status).toBe(200);

        const retryData = (await retry.json()) as { entries: { payload: unknown; seq: number; type: string }[] };

        expect(retryData.entries).toStrictEqual(firstData.entries);

        const sizeRes = await doFetch(do_, "GET", "/size");
        const size = (await sizeRes.json()) as { count: number };

        // Not 4 — the retry did not insert duplicates.
        expect(size.count).toBe(2);
    });

    it("multiple retries of the same batchId still yield exactly one persisted copy", async () => {
        expect.assertions(1);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        const body = { batchId: "dup-key", events: [{ type: "z", payload: {} }] };

        await doFetch(do_, "POST", "/append", body);
        await doFetch(do_, "POST", "/append", body);
        await doFetch(do_, "POST", "/append", body);

        const sizeRes = await doFetch(do_, "GET", "/size");
        const size = (await sizeRes.json()) as { count: number };

        expect(size.count).toBe(1);
    });

    it("different batchIds are independent — no false-positive dedup", async () => {
        expect.assertions(1);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        await doFetch(do_, "POST", "/append", { batchId: "batch-a", events: [{ type: "a", payload: {} }] });
        await doFetch(do_, "POST", "/append", { batchId: "batch-b", events: [{ type: "b", payload: {} }] });

        const sizeRes = await doFetch(do_, "GET", "/size");
        const size = (await sizeRes.json()) as { count: number };

        expect(size.count).toBe(2);
    });

    it("rejects an empty-string batchId", async () => {
        expect.assertions(1);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        const res = await doFetch(do_, "POST", "/append", { batchId: "", events: [{ type: "a", payload: {} }] });

        expect(res.status).toBe(400);
    });

    it("reusing a batchId with a DIFFERENT event batch is rejected as a conflict, not silently dropped", async () => {
        expect.assertions(4);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        const first = await doFetch(do_, "POST", "/append", { batchId: "reused-key", events: [{ type: "a", payload: { n: 1 } }] });

        expect(first.status).toBe(200);

        // Same idempotency key, but genuinely different event contents —
        // `#findBatch` must not just match on `batchId` and hand back the
        // unrelated original entries.
        const second = await doFetch(do_, "POST", "/append", { batchId: "reused-key", events: [{ type: "b", payload: { n: 2 } }] });

        expect(second.status).toBe(409);

        const body = (await second.json()) as { error: { code: string } };

        expect(body.error.code).toBe("CONFLICT");

        // The second (conflicting) batch must not have been persisted either.
        const sizeRes = await doFetch(do_, "GET", "/size");
        const size = (await sizeRes.json()) as { count: number };

        expect(size.count).toBe(1);
    });

    it("treats an own __proto__ key as payload content when a batchId is reused", async () => {
        expect.assertions(2);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);

        // JSON.parse makes `__proto__` an own key. An object literal would set the prototype instead, and the payload would be `{}`.
        const first = await doFetch(do_, "POST", "/append", {
            batchId: "proto-key",
            events: [{ type: "a", payload: JSON.parse('{"__proto__":1}') }],
        });

        expect(first.status).toBe(200);

        const second = await doFetch(do_, "POST", "/append", {
            batchId: "proto-key",
            events: [{ type: "a", payload: JSON.parse('{"__proto__":2}') }],
        });

        expect(second.status).toBe(409);
    });
});

/** The single request a client sent; a replay test fails here, not on an undefined `Request`, if the append sent none. */
const onlyRequest = (requests: Request[]): Request => {
    const [request] = requests;

    if (request === undefined) {
        throw new Error("append sent no request");
    }

    return request;
};

describe("eventLogDO /append — replay", () => {
    it("a captured signed append, re-sent to the DO, writes no second event", async () => {
        expect.assertions(3);

        const do_ = new EventLogDO(createMockState(), TEST_ENV);
        const captured: Request[] = [];
        const client = new EventLogDOClient({
            env: TEST_ENV,
            instance: TEST_INSTANCE,
            fetch: (req) => {
                captured.push(req.clone());
                return do_.fetch(req);
            },
        });

        const appended = await client.append([{ payload: { n: 1 }, type: "a" }]);
        const replay = await do_.fetch(onlyRequest(captured).clone());

        expect(replay.status).toBe(200);
        await expect(replay.json()).resolves.toMatchObject({ entries: appended.map((entry) => ({ seq: entry.seq })) });
        await expect(client.getSize()).resolves.toBe(1);
    });
});
