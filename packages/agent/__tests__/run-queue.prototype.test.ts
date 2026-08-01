import { describe, expect, it } from "vitest";

import type { PrototypeDatabase, PrototypeIndexBuilder, PrototypeIndexQuery, PrototypeRow } from "../src/run-queue.prototype";
import { completeRunAndDequeue, ensureThreadOrQueue, MAX_QUEUE_DEPTH, QueueConflictError } from "../src/run-queue.prototype";

const QUEUE_FULL_PATTERN = /run queue is full/u;
const IN_FLIGHT_PATTERN = /already has a run in flight/u;

/** Same fields the prototype's two indexes order by. */
const ORDER_FIELDS: Record<string, string> = { byThread: "position" };

const collectConditions = (build: (q: PrototypeIndexBuilder) => unknown): [string, unknown][] => {
    const conditions: [string, unknown][] = [];
    const builder: PrototypeIndexBuilder = {
        eq: (field, value) => {
            conditions.push([field, value]);

            return builder;
        },
    };

    build(builder);

    return conditions;
};

const matchesConditions = (row: PrototypeRow, conditions: [string, unknown][]): boolean => conditions.every(([field, value]) => row[field] === value);

const sortByField = (rows: PrototypeRow[], field: string | undefined, indexName: string, direction: "asc" | "desc"): PrototypeRow[] => {
    if (field === undefined) {
        throw new Error(`test double: .order() is only modeled for a known-keyed index, not "${indexName}"`);
    }

    return rows.toSorted((a, b) => {
        const delta = ((a[field] as number | undefined) ?? 0) - ((b[field] as number | undefined) ?? 0);

        return direction === "desc" ? -delta : delta;
    });
};

const makePrototypeIndexQuery = (allRows: PrototypeRow[], indexName: string, conditions: [string, unknown][]): PrototypeIndexQuery => {
    const matches = (): PrototypeRow[] => allRows.filter((row) => matchesConditions(row, conditions));

    return {
        collect: async () => matches(),
        first: async () => matches()[0] ?? null,
        order: (direction: "asc" | "desc") => {
            return {
                collect: async () => sortByField(matches(), ORDER_FIELDS[indexName], indexName, direction),
            };
        },
    };
};

/**
 * Minimal `ctx.db` double for the prototype — same shape as
 * `__tests__/component.test.ts`'s `fakeDatabase`, extended with `remove` (the
 * prototype needs to delete a dequeued queue row).
 */
const fakePrototypeDatabase = (): { db: PrototypeDatabase; rows: Map<string, PrototypeRow[]> } => {
    const rows = new Map<string, PrototypeRow[]>();
    let nextId = 0;

    const tableRows = (table: string): PrototypeRow[] => {
        const existing = rows.get(table);

        if (existing) {
            return existing;
        }

        const created: PrototypeRow[] = [];

        rows.set(table, created);

        return created;
    };

    const db: PrototypeDatabase = {
        insert: async (table, document) => {
            const id = `id-${String(nextId)}`;

            nextId += 1;
            tableRows(table).push({ ...document, _id: id });

            return id;
        },
        patch: async (id, patch) => {
            for (const tableContent of rows.values()) {
                const row = tableContent.find((candidate) => candidate["_id"] === id);

                if (row) {
                    Object.assign(row, patch);
                }
            }
        },
        query: (table) => {
            return {
                withIndex: (name, build) => makePrototypeIndexQuery(tableRows(table), name, collectConditions(build)),
            };
        },
        remove: async (id) => {
            for (const tableContent of rows.values()) {
                const index = tableContent.findIndex((candidate) => candidate["_id"] === id);

                if (index !== -1) {
                    tableContent.splice(index, 1);
                }
            }
        },
    };

    return { db, rows };
};

describe("run-queue prototype (plan 240 spike)", () => {
    it("parks B instead of rejecting it, then resumes B in order when A completes", async () => {
        const { db } = fakePrototypeDatabase();

        // A starts and is running.
        await expect(ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" })).resolves.toStrictEqual({ created: true });

        // B starts while A is in flight, with onConcurrentRun: "queue" — must
        // park, not throw CONFLICT.
        const parked = await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "queue" });

        expect(parked).toStrictEqual({ created: false, position: 0, queued: true });

        // A completes — dequeue-and-handoff must return B's instance id and
        // stamp the thread over to B atomically.
        const handoff = await completeRunAndDequeue(db, { instanceId: "wf-a", key: "t-1", terminalStatus: "idle" });

        expect(handoff).toStrictEqual({ dequeued: "wf-b" });
    });

    it("preserves A -> B -> C ordering: C parks behind B, and dequeues follow FIFO position, not completion order", async () => {
        const { db, rows } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });

        const parkedB = await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "queue" });
        const parkedC = await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-c", key: "t-1", onConcurrentRun: "queue" });

        expect(parkedB).toStrictEqual({ created: false, position: 0, queued: true });
        expect(parkedC).toStrictEqual({ created: false, position: 1, queued: true });

        // A completes -> hands off to B (the head, position 0).
        const ownershipSequence: string[] = ["wf-a"];
        const firstHandoff = await completeRunAndDequeue(db, { instanceId: "wf-a", key: "t-1", terminalStatus: "idle" });

        expect(firstHandoff).toStrictEqual({ dequeued: "wf-b" });

        ownershipSequence.push("wf-b");

        expect(rows.get("proto_agent_threads")?.[0]?.["instanceId"]).toBe("wf-b");

        // B completes -> hands off to C (the only one left).
        const secondHandoff = await completeRunAndDequeue(db, { instanceId: "wf-b", key: "t-1", terminalStatus: "idle" });

        expect(secondHandoff).toStrictEqual({ dequeued: "wf-c" });

        ownershipSequence.push("wf-c");

        expect(rows.get("proto_agent_threads")?.[0]?.["instanceId"]).toBe("wf-c");

        // C completes -> nobody left, thread goes terminal.
        const thirdHandoff = await completeRunAndDequeue(db, { instanceId: "wf-c", key: "t-1", terminalStatus: "idle" });

        expect(thirdHandoff).toStrictEqual({ dequeued: undefined });
        expect(rows.get("proto_agent_threads")?.[0]?.["status"]).toBe("idle");

        expect(ownershipSequence).toStrictEqual(["wf-a", "wf-b", "wf-c"]);
        expect(rows.get("proto_agent_run_queue")).toHaveLength(0);
    });

    it("a replay of B's still-parked bootstrap does not duplicate its queue entry or change its position", async () => {
        const { db, rows } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });
        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "queue" });
        // A THIRD run parks behind B before B replays, so a mis-ordered
        // duplicate would be observable as a position/count change.
        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-c", key: "t-1", onConcurrentRun: "queue" });

        expect(rows.get("proto_agent_run_queue")).toHaveLength(2);

        // B's workflow replays (re-executes ensureThread for real, since it
        // runs outside step.do) while still parked, before A has completed.
        const replay = await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "queue" });

        expect(replay).toStrictEqual({ created: false, position: 0, queued: true });
        expect(rows.get("proto_agent_run_queue")).toHaveLength(2);

        // Ordering still resolves B then C — the replay didn't reshuffle anything.
        const firstHandoff = await completeRunAndDequeue(db, { instanceId: "wf-a", key: "t-1", terminalStatus: "idle" });

        expect(firstHandoff).toStrictEqual({ dequeued: "wf-b" });

        const secondHandoff = await completeRunAndDequeue(db, { instanceId: "wf-b", key: "t-1", terminalStatus: "idle" });

        expect(secondHandoff).toStrictEqual({ dequeued: "wf-c" });
    });

    it("a replay of A's own completion does not double-dequeue and skip C's turn", async () => {
        const { db } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });
        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "queue" });
        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-c", key: "t-1", onConcurrentRun: "queue" });

        const firstCall = await completeRunAndDequeue(db, { instanceId: "wf-a", key: "t-1", terminalStatus: "idle" });

        expect(firstCall).toStrictEqual({ dequeued: "wf-b" });

        // A REPLAYS its own completion step (e.g. the workflow re-runs after a
        // crash before the step was durably recorded as done). The thread no
        // longer belongs to "wf-a", so this must be a no-op — NOT a second
        // dequeue that would hand C the thread out from under B.
        const replayedCall = await completeRunAndDequeue(db, { instanceId: "wf-a", key: "t-1", terminalStatus: "idle" });

        expect(replayedCall).toStrictEqual({ dequeued: undefined });

        // C is still parked, waiting for B — not skipped.
        const secondCall = await completeRunAndDequeue(db, { instanceId: "wf-b", key: "t-1", terminalStatus: "idle" });

        expect(secondCall).toStrictEqual({ dequeued: "wf-c" });
    });

    it("enforces the queue depth bound, rejecting past the cap instead of growing unbounded durable state", async () => {
        const { db, rows } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });

        for (let index = 0; index < MAX_QUEUE_DEPTH; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each enqueue depends on the prior one's committed depth
            await ensureThreadOrQueue(db, { agent: "support", instanceId: `wf-q${String(index)}`, key: "t-1", onConcurrentRun: "queue" });
        }

        expect(rows.get("proto_agent_run_queue")).toHaveLength(MAX_QUEUE_DEPTH);

        await expect(ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-overflow", key: "t-1", onConcurrentRun: "queue" })).rejects.toThrow(
            QUEUE_FULL_PATTERN,
        );

        // The overflowing attempt left no trace.
        expect(rows.get("proto_agent_run_queue")).toHaveLength(MAX_QUEUE_DEPTH);
    });

    it("still throws CONFLICT for the default (reject) policy — unchanged from today", async () => {
        const { db } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });

        await expect(ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1" })).rejects.toThrow(IN_FLIGHT_PATTERN);
        await expect(ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-b", key: "t-1", onConcurrentRun: "reject" })).rejects.toThrow(
            IN_FLIGHT_PATTERN,
        );
    });

    it("still replaces (terminating the in-flight run's ownership) — unchanged from today", async () => {
        const { db, rows } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-old", key: "t-1" });

        const result = await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-new", key: "t-1", onConcurrentRun: "replace" });

        expect(result).toStrictEqual({ created: false, priorInstanceId: "wf-old", replaced: true });
        expect(rows.get("proto_agent_threads")?.[0]?.["instanceId"]).toBe("wf-new");
    });

    it("rejects an id-less dispatch under queue policy rather than parking an un-wakeable run", async () => {
        const { db } = fakePrototypeDatabase();

        await ensureThreadOrQueue(db, { agent: "support", instanceId: "wf-a", key: "t-1" });

        await expect(ensureThreadOrQueue(db, { agent: "support", key: "t-1", onConcurrentRun: "queue" })).rejects.toThrow(QueueConflictError);
    });
});
