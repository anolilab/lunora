/**
 * `onConcurrentRun: "queue"` — the durable per-thread run queue.
 *
 * Exercises the REAL `agentEnsureThread` / `agentCompleteRun` mutations over an
 * in-memory `ctx.db`, because the properties under test are all about what the
 * mutations do to the tables: FIFO order, an idempotent enqueue under replay, an
 * idempotent handoff under replay, and the bound.
 */
import { describe, expect, it } from "vitest";

import { agentComponent } from "../src/component";

interface FakeRow extends Record<string, unknown> {
    _id: string;
}

/** Collect the `.eq(...)` conditions a `withIndex` callback declares. */
const collectConditions = (build: (q: unknown) => unknown): [string, unknown][] => {
    const conditions: [string, unknown][] = [];
    const builder = {
        eq: (field: string, value: unknown) => {
            conditions.push([field, value]);

            return builder;
        },
    };

    build(builder);

    return conditions;
};

/** Filter by the `.eq(...)` conditions; insertion order stands in for index order. */
const makeIndexQuery = (candidates: FakeRow[], build: (q: unknown) => unknown): { collect: () => Promise<FakeRow[]>; first: () => Promise<FakeRow | null> } => {
    const conditions = collectConditions(build);
    const matches = (): FakeRow[] => candidates.filter((row) => conditions.every(([field, value]) => row[field] === value));

    return {
        collect: async () => matches(),
        first: async () => matches()[0] ?? null,
    };
};

/**
 * An in-memory `ctx.db`. `withIndex` filters by the declared equalities and — as
 * the real index read does — returns rows in insertion order, which for the
 * `(threadKey, position)` index is position order.
 */
const fakeDatabase = (): { database: Record<string, unknown>; rows: Map<string, FakeRow[]> } => {
    const rows = new Map<string, FakeRow[]>();
    let nextId = 0;

    const tableRows = (table: string): FakeRow[] => {
        const existing = rows.get(table);

        if (existing) {
            return existing;
        }

        const created: FakeRow[] = [];

        rows.set(table, created);

        return created;
    };

    const database = {
        delete: async (id: string) => {
            for (const [table, tableContent] of rows) {
                rows.set(
                    table,
                    tableContent.filter((row) => row["_id"] !== id),
                );
            }
        },
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `id-${String(nextId)}`;

            nextId += 1;
            tableRows(table).push({ ...document, _id: id });

            return id;
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            for (const tableContent of rows.values()) {
                const row = tableContent.find((candidate) => candidate["_id"] === id);

                if (row) {
                    for (const [key, value] of Object.entries(patch)) {
                        if (value === undefined) {
                            Reflect.deleteProperty(row, key);
                        } else {
                            row[key] = value;
                        }
                    }
                }
            }
        },
        query: (table: string) => {
            return {
                withIndex: (_name: string, build: (q: unknown) => unknown) => makeIndexQuery(tableRows(table), build),
            };
        },
    };

    return { database, rows };
};

const setup = () => {
    const { database, rows } = fakeDatabase();
    const { functions } = agentComponent();
    const context = { auth: { userId: undefined }, db: database };

    return {
        complete: async (arguments_: Record<string, unknown>) =>
            (await functions.agentCompleteRun.handler(context, arguments_ as never)) as { dequeued?: string },
        queue: (): FakeRow[] => rows.get("agent_run_queue") ?? [],
        start: async (instanceId?: string) =>
            (await functions.agentEnsureThread.handler(context, {
                agent: "support",
                key: "thread-1",
                onConcurrentRun: "queue",
                ...(instanceId === undefined ? {} : { instanceId }),
            } as never)) as { created: boolean; position?: number; queued?: boolean },
        thread: (): FakeRow | undefined => (rows.get("agent_threads") ?? [])[0],
    };
};

describe("onConcurrentRun: queue", () => {
    it("parks runs behind the one in flight and hands the thread over in FIFO order", async () => {
        expect.assertions(7);

        const { complete, queue, start, thread } = setup();

        await expect(start("wf-a")).resolves.toStrictEqual({ created: true });
        await expect(start("wf-b")).resolves.toStrictEqual({ created: false, position: 0, queued: true });
        await expect(start("wf-c")).resolves.toStrictEqual({ created: false, position: 1, queued: true });
        // A parked run must not take the thread from the one in flight.
        expect(thread()?.["instanceId"]).toBe("wf-a");

        // A finishes: the thread goes to B (not to the terminal status), and B's
        // queue row is consumed in the same mutation that transfers ownership.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({ dequeued: "wf-b" });
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("goes idle once the queue drains", async () => {
        expect.assertions(2);

        const { complete, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        await expect(complete({ instanceId: "wf-b", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "idle" });
    });

    it("is idempotent under replay: a parked run re-enqueues to the same slot", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");
        await start("wf-b");

        // A workflow replay re-runs the bootstrap for real (it is outside step.do).
        await expect(start("wf-b")).resolves.toStrictEqual({ created: false, position: 0, queued: true });
        expect(queue()).toHaveLength(1);
    });

    it("is idempotent under replay: a finished run's completion never dequeues twice", async () => {
        expect.assertions(3);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await start("wf-c");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        // A's completion replays after ownership already moved to B. Dequeuing
        // again here would skip B's turn entirely.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()?.["instanceId"]).toBe("wf-b");
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("hands the thread on even when the finishing run errored", async () => {
        expect.assertions(1);

        const { complete, start } = setup();

        await start("wf-a");
        await start("wf-b");

        // B is waiting for A to END, not to succeed.
        await expect(complete({ error: "boom", instanceId: "wf-a", key: "thread-1", status: "error" })).resolves.toStrictEqual({ dequeued: "wf-b" });
    });

    it("rejects past the depth cap instead of parking unboundedly", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");

        for (const id of ["wf-b", "wf-c", "wf-d", "wf-e", "wf-f"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each enqueue must observe the previous one's row
            await start(id);
        }

        expect(queue()).toHaveLength(5);
        await expect(start("wf-g")).rejects.toThrow("run queue is full");
    });

    it("refuses to queue a dispatch that has no instance id to wake", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");

        // The inbound-email / inbound-channel paths dispatch with no instanceId:
        // nothing could tell two such dispatches apart later to wake the right
        // one, so parking them would strand a run rather than order it.
        await expect(start()).rejects.toThrow("cannot queue a dispatch with no instance id");
        expect(queue()).toHaveLength(0);
    });
});
