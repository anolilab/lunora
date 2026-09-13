/**
 * A deferred `ctx.scheduler` job that fails to reach the scheduler, driven
 * through the REAL dispatch.
 *
 * The defect this suite pins is invisible to every substring assertion around the
 * emitter, and to every unit test of the deferral facade: each piece behaved
 * exactly as documented. The mutation's writes committed. Its replay-dedup row
 * committed inside the same span, as a later fix deliberately arranged. The
 * post-commit settle dispatched the buffered call and rethrew when it failed, as
 * its docblock promises. And the sum of those three correct behaviours was that a
 * client replaying the failed mutation short-circuited on the dedup row, was told
 * it had succeeded, and the scheduled job existed nowhere. Only running the whole
 * path shows that.
 *
 * So this suite drives the committed golden `_generated/shard.ts`
 * (`fixtures/delta-sync`) against the real `@lunora/do` base class and the real
 * `@lunora/server` deferral modules, on Node's own SQLite — the same harness
 * `emit-shard-deferred-deletes.dispatch.test.ts` established, and for the same
 * reason. The only doubles are the HOST's: `storage.transaction` (BEGIN/ROLLBACK
 * on `node:sqlite`, the semantics workerd gives `state.storage.transaction`) and
 * the scheduler, which records what it was asked to schedule and can be made to
 * fail. `handleRpc`, `buildCtx`, `runMutationTransaction` and the outbox are
 * generated or shipped code, executed.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

/** The slice of a dispatch ctx these handlers touch. */
interface TestCtx {
    db: { insert: (table: string, row: Record<string, unknown>) => Promise<unknown>; query: (table: string) => { collect: () => Promise<unknown[]> } };
    runMutation: (reference: { __lunoraRef: string }, args: Record<string, unknown>) => Promise<unknown>;
    scheduler: { runAfter: (delayMs: number, target: unknown, args: unknown) => Promise<string> };
}

/** One call the fake scheduler accepted. */
interface AcceptedJob {
    args: unknown;
    id: string | undefined;
    target: unknown;
}

/**
 * The DO state the shard is constructed with. `transaction` is the host primitive
 * the rollback under test actually needs — a state without it falls through to a
 * bare call and every assertion below would pass for the wrong reason.
 */
const createState = (): { run: (query: string, ...parameters: unknown[]) => unknown; state: unknown } => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
        run,
        state: {
            acceptWebSocket: () => undefined,
            getWebSockets: () => [],
            id: { name: "shard-a" },
            storage: {
                sql: { exec: run },
                transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                    run("BEGIN");

                    try {
                        const result = await closure();

                        run("COMMIT");

                        return result;
                    } catch (error) {
                        run("ROLLBACK");

                        throw error;
                    }
                },
            },
        },
    };
};

interface Harness {
    /** Make every live entry due now, so the retry ladder can be driven without waiting it out. */
    makeDue: () => void;
    /** Every entry still in `__schedule_outbox`, oldest first. */
    outbox: () => { attempts: number; dead: number; id: string }[];
    /** Drive the outbox retry tier the shared poll alarm runs. */
    retry: () => Promise<number | undefined>;
    /** Jobs the scheduler accepted. */
    scheduled: AcceptedJob[];
    /** Flip the scheduler between "unreachable" and "healthy". */
    setReachable: (reachable: boolean) => void;
    shard: {
        cached: (mutationId: string) => { value: unknown } | undefined;
        handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown>;
        underMutationId: (id: string) => void;
    };
}

const createHarness = (): Harness => {
    const scheduled: AcceptedJob[] = [];
    let reachable = true;

    const accept = async (target: unknown, args: unknown, options?: { id?: string }): Promise<string> => {
        if (!reachable) {
            throw new Error("SchedulerDO unreachable");
        }

        const id = options?.id ?? "minted";

        scheduled.push({ args, id, target });

        return id;
    };

    const ShardClass = createShardDO({
        scheduler: () => {
            return {
                cancel: async (): Promise<{ cancelled: boolean }> => {
                    return { cancelled: false };
                },
                runAfter: async (_delayMs: number, target: unknown, args: unknown, options?: { id?: string }): Promise<string> => accept(target, args, options),
                runAt: async (_timestampMs: number, target: unknown, args: unknown, options?: { id?: string }): Promise<string> =>
                    accept(target, args, options),
            };
        },
    });

    const { run, state } = createState();

    /**
     * The protected surface this suite has to reach. `underMutationId` stands in
     * for the `x-lunora-mutation-id` header `fetch` stashes — the dedup namespace
     * and the id are what decide whether a replay short-circuits, and they are
     * request state, not dispatch arguments.
     */
    class Probe extends (ShardClass as unknown as new (state: unknown, env: unknown) => Record<string, unknown>) {
        public cached(mutationId: string): { value: unknown } | undefined {
            return (this as unknown as { readIdempotentResult: (id: string) => { value: unknown } | undefined }).readIdempotentResult(mutationId);
        }

        public retry(): Promise<number | undefined> {
            return (this as unknown as { pollScheduleOutbox: () => Promise<number | undefined> }).pollScheduleOutbox();
        }

        public underMutationId(id: string): void {
            Object.assign(this, { currentRequestMutationId: id, currentRequestSystem: true });
        }
    }

    const shard = new Probe(state, {}) as unknown as Harness["shard"] & { retry: () => Promise<number | undefined> };

    return {
        makeDue: () => {
            run("UPDATE __schedule_outbox SET next_attempt_at = 0 WHERE dead = 0");
        },
        // Re-shaped into plain objects: `node:sqlite` answers null-prototype rows,
        // which `toStrictEqual` reports as unequal with no visible difference.
        outbox: () =>
            (
                run("SELECT id, attempts, dead FROM __schedule_outbox ORDER BY created_at ASC, id ASC") as {
                    toArray: () => { attempts: number; dead: number; id: string }[];
                }
            )
                .toArray()
                .map((row) => {
                    return { attempts: row.attempts, dead: row.dead, id: row.id };
                }),
        retry: () => shard.retry(),
        scheduled,
        shard,
        setReachable: (next: boolean) => {
            reachable = next;
        },
    };
};

const register = (path: string, kind: "action" | "mutation" | "query", handler: (ctx: TestCtx) => unknown): void => {
    (LUNORA_FUNCTIONS as unknown as Record<string, unknown>)[path] = { args: {}, handler, kind };
};

describe("emitted shard — a deferred schedule that never reaches the scheduler", () => {
    beforeAll(() => {
        register("outbox:orderPlaced", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "order", ownerId: "u1" });

            const jobId = await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "o-1" });

            return { jobId, ok: true };
        });

        register("outbox:rollback", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "doomed", ownerId: "u1" });
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "doomed" });

            throw new Error("boom after runAfter");
        });

        // `ctx.runMutation` from INSIDE a mutation: no savepoints, so the inner
        // dispatch rides the enclosing span — which COMMITS even though the inner
        // handler threw. Its schedules are dropped anyway.
        register("outbox:outerOverInnerRollback", "mutation", async (ctx) => {
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:outer" }, {});

            try {
                await ctx.runMutation({ __lunoraRef: "outbox:rollback" }, {});
            } catch {
                // swallowed, exactly as the documented action shape does
            }
        });

        register("outbox:countNotes", "query", async (ctx) => {
            const rows = await ctx.db.query("notes").collect();

            return rows.length;
        });
    });

    it("keeps custody of the job when the post-commit dispatch fails, and retries it to the same id", async () => {
        expect.assertions(8);

        const harness = createHarness();

        harness.setReachable(false);
        harness.shard.underMutationId("m-1");

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        // The mutation's writes are durable...
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(1);

        // ...and so is its replay-dedup row, carrying the job id the handler was
        // handed. This pair is the whole defect: a client replaying `m-1` is
        // answered from this row and told the mutation succeeded.
        const cached = harness.shard.cached("m-1") as { value: { jobId: string; ok: boolean } } | undefined;

        expect(cached?.value.ok).toBe(true);
        expect(harness.scheduled).toStrictEqual([]);

        // So the job has to be somewhere, and it is: one live outbox entry, under
        // the id the caller was told its job had.
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 0, id: cached?.value.jobId }]);

        // The scheduler comes back; the retry tier hands it the job — same id, so
        // a caller holding it can still `cancel`, and a duplicate cannot be minted.
        harness.setReachable(true);

        await expect(harness.retry()).resolves.toBeUndefined();

        expect(harness.scheduled).toStrictEqual([{ args: { orderId: "o-1" }, id: cached?.value.jobId, target: { __lunoraRef: "outbox:charge" } }]);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("takes no custody at all when the dispatch succeeds", async () => {
        expect.assertions(2);

        const harness = createHarness();

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).resolves.toStrictEqual({ jobId: expect.any(String) as unknown as string, ok: true });

        // Custody lasts from the COMMIT to the acknowledgement and no longer, so
        // the steady state leaves the table empty and the alarm tier dormant.
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("drops custody with the transaction when the mutation rolls back", async () => {
        expect.assertions(3);

        const harness = createHarness();

        await expect(harness.shard.handleRpc("outbox:rollback", {})).rejects.toThrow("boom after runAfter");
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        // The entry was written inside the span, so ROLLBACK took it. Retrying a
        // job whose writes never landed is the failure mode the buffering exists
        // to prevent, and the outbox must not reintroduce it.
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("drops only the inner window's custody when a nested mutation throws inside a committing one", async () => {
        expect.assertions(3);

        const harness = createHarness();

        await expect(harness.shard.handleRpc("outbox:outerOverInnerRollback", {})).resolves.toBeUndefined();

        // The inner dispatch shares the enclosing span, so its entry is NOT rolled
        // back by its own throw — the settle has to release it explicitly, or the
        // retry loop resurrects a job the design deliberately dropped.
        expect(harness.outbox()).toStrictEqual([]);
        expect(harness.scheduled).toStrictEqual([{ args: {}, id: expect.any(String), target: { __lunoraRef: "outbox:outer" } }]);
    });

    it("parks an entry the scheduler never accepts, rather than retrying it forever", async () => {
        expect.assertions(4);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        // Seven attempts fail and each pushes the entry out along the ladder; the
        // test skips the wait rather than the attempt, so the ceiling being
        // exercised is the real one.
        for (let attempt = 1; attempt < 8; attempt += 1) {
            harness.makeDue();
            // eslint-disable-next-line no-await-in-loop -- the ladder is sequential by construction: each attempt reads the row the previous one wrote
            await harness.retry();
        }

        expect(harness.outbox()).toStrictEqual([{ attempts: 7, dead: 0, id: expect.any(String) }]);

        // The eighth exhausts it. The entry is PARKED, not deleted: a job that was
        // promised to a caller and will not be enqueued is evidence, and the
        // operator needs to be able to find it.
        harness.makeDue();

        await harness.retry();

        expect(harness.outbox()).toStrictEqual([{ attempts: 8, dead: 1, id: expect.any(String) }]);

        // And it is out of the loop for good — a dead entry is not re-offered, so
        // the alarm goes quiet instead of spinning on a job that will never land.
        harness.makeDue();

        await expect(harness.retry()).resolves.toBeUndefined();
    });
});
