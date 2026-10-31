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

import { LunoraError } from "@lunora/errors";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

/** The slice of a dispatch ctx these handlers touch. */
interface TestCtx {
    db: { insert: (table: string, row: Record<string, unknown>) => Promise<unknown>; query: (table: string) => { collect: () => Promise<unknown[]> } };
    runMutation: (reference: { __lunoraRef: string }, args: Record<string, unknown>) => Promise<unknown>;
    scheduler: { runAfter: (delayMs: number, target: unknown, args: unknown, options?: Record<string, unknown>) => Promise<string> };
}

/** One call the fake scheduler accepted. */
interface AcceptedJob {
    args: unknown;
    id: string | undefined;
    target: unknown;
}

/** Every option the fake scheduler was handed, accepted or not, in call order. */
type ReceivedOptions = Record<string, unknown> | undefined;

/**
 * The DO state the shard is constructed with. `transaction` is the host primitive
 * the rollback under test actually needs — a state without it falls through to a
 * bare call and every assertion below would pass for the wrong reason.
 */
const createState = (alarms: number[], alarmControl: { fail: boolean }): { run: (query: string, ...parameters: unknown[]) => unknown; state: unknown } => {
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
                setAlarm: async (at: number | Date): Promise<void> => {
                    if (alarmControl.fail) {
                        throw new Error("alarm refused");
                    }

                    alarms.push(Number(at));
                },
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
    /** Instants the shard armed its alarm for. */
    alarms: number[];
    /** Audit entries the shard wrote, oldest first. */
    audit: () => { detail: string | null; op: string }[];
    /** Ids the scheduler was asked to cancel. */
    cancelled: string[];
    /** Whether the scheduler held the job each time `cancel` was called, in order. */
    cancelOutcomes: boolean[];
    /** Operator drop of an outbox entry. */
    drop: (id: string) => Promise<Response>;
    /** Make arming the alarm fail (or work again). */
    failAlarms: (fail: boolean) => void;
    /** Make `cancel` throw `error` (or work again, with `undefined`). */
    failCancel: (error: Error | undefined) => void;
    /** Make the scheduler throw `error` on every call until reset with `setReachable(true)`. */
    failWith: (error: Error) => void;
    /** Hold the next scheduler call: `entered` settles once it is waiting, `release` lets it finish. */
    hold: () => { entered: Promise<void>; release: () => void };
    /** Hold the next `cancel` call the same way. */
    holdCancel: () => { entered: Promise<void>; release: () => void };
    /** Shard log lines pushed for `functionPath`. */
    logs: (functionPath: string) => { level: string; message: string }[];
    /** Make every live entry due now, so the retry ladder can be driven without waiting it out. */
    makeDue: () => void;
    /** Calls in the order they happened: `run` for an accepted hand-off, `cancel-done` when a cancel settled. */
    order: string[];
    /** Every entry still in `__schedule_outbox`, oldest first. */
    outbox: () => { attempts: number; dead: number; id: string }[];
    /** Options the scheduler was handed on each call. */
    received: ReceivedOptions[];
    /** Make `cancel` answer `{ cancelled: false }` whatever the scheduler holds. */
    refuseCancels: (refuse: boolean) => void;
    /** Drive the outbox retry tier the shared poll alarm runs. */
    retry: () => Promise<number | undefined>;
    /** Run raw SQL against the shard's store. */
    run: (query: string, ...parameters: unknown[]) => unknown;
    /** Jobs the scheduler accepted. */
    scheduled: AcceptedJob[];
    /** Flip the scheduler between "unreachable" and "healthy". */
    setReachable: (reachable: boolean) => void;
    shard: {
        cached: (mutationId: string) => { value: unknown } | undefined;
        drop: (id: string) => Promise<Response>;
        handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown>;
        requeue: (id: string) => Promise<Response>;
        underMutationId: (id: string) => void;
    };
}

const createHarness = (configuration: { scheduler?: boolean } = {}): Harness => {
    const scheduled: AcceptedJob[] = [];
    const received: ReceivedOptions[] = [];
    const alarms: number[] = [];
    const cancelled: string[] = [];
    const cancelOutcomes: boolean[] = [];
    const order: string[] = [];
    let refusing = false;
    let failure: Error | undefined;
    let cancelFailure: Error | undefined;
    let heldCancel: { entered: () => void; released: Promise<undefined> } | undefined;
    let held: { entered: () => void; released: Promise<undefined> } | undefined;

    const accept = async (target: unknown, args: unknown, options?: { id?: string }): Promise<string> => {
        received.push(options);
        order.push("run");

        if (held !== undefined) {
            const { entered, released } = held;

            held = undefined;
            entered();
            await released;
        }

        if (failure !== undefined) {
            throw failure;
        }

        const id = options?.id ?? "minted";

        scheduled.push({ args, id, target });

        return id;
    };

    const ShardClass = createShardDO({
        scheduler:
            (configuration.scheduler ?? true)
                ? () => {
                      return {
                          cancel: async (id: string): Promise<{ cancelled: boolean }> => {
                              if (heldCancel !== undefined) {
                                  const { entered, released } = heldCancel;

                                  heldCancel = undefined;
                                  entered();
                                  await released;
                              }

                              if (cancelFailure !== undefined) {
                                  throw cancelFailure;
                              }

                              cancelled.push(id);

                              const holds = scheduled.some((job) => job.id === id) && !refusing;

                              cancelOutcomes.push(holds);
                              order.push("cancel-done");

                              return { cancelled: holds };
                          },
                          runAfter: async (_delayMs: number, target: unknown, args: unknown, options?: { id?: string }): Promise<string> =>
                              accept(target, args, options),
                          runAt: async (_timestampMs: number, target: unknown, args: unknown, options?: { id?: string }): Promise<string> =>
                              accept(target, args, options),
                      };
                  }
                : undefined,
    });

    const alarmControl = { fail: false };
    const { run, state } = createState(alarms, alarmControl);

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

        public drop(id: string): Promise<Response> {
            return Promise.resolve(
                (this as unknown as { handleDropOutboxEntry: (args: Record<string, unknown>) => Response | Promise<Response> }).handleDropOutboxEntry({ id }),
            );
        }

        public requeue(id: string): Promise<Response> {
            return (this as unknown as { handleRetryOutboxEntry: (args: Record<string, unknown>) => Promise<Response> }).handleRetryOutboxEntry({ id });
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
        alarms,
        audit: () =>
            (run("SELECT op, detail FROM __lunora_audit__ ORDER BY seq ASC") as { toArray: () => { detail: string | null; op: string }[] })
                .toArray()
                .map((row) => {
                    return { detail: row.detail, op: row.op };
                }),
        cancelOutcomes,
        cancelled,
        order,
        refuseCancels: (refuse: boolean) => {
            refusing = refuse;
        },
        failAlarms: (fail: boolean) => {
            alarmControl.fail = fail;
        },
        drop: (id: string) => shard.drop(id),
        failCancel: (error: Error | undefined) => {
            cancelFailure = error;
        },
        failWith: (error: Error) => {
            failure = error;
        },
        holdCancel: () => {
            const entered = Promise.withResolvers<undefined>();
            const released = Promise.withResolvers<undefined>();

            heldCancel = {
                entered: () => {
                    entered.resolve(undefined);
                },
                released: released.promise,
            };

            return {
                entered: entered.promise,
                release: () => {
                    released.resolve(undefined);
                },
            };
        },
        hold: () => {
            const entered = Promise.withResolvers<undefined>();
            const released = Promise.withResolvers<undefined>();

            held = {
                entered: () => {
                    entered.resolve(undefined);
                },
                released: released.promise,
            };

            return {
                entered: entered.promise,
                release: () => {
                    released.resolve(undefined);
                },
            };
        },
        logs: (functionPath: string) =>
            (shard as unknown as { logs: { entries: () => { functionPath: string; level: string; message: string }[] } }).logs
                .entries()
                .filter((entry) => entry.functionPath === functionPath)
                .map((entry) => {
                    return { level: entry.level, message: entry.message };
                }),
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
        received,
        retry: () => shard.retry(),
        run,
        scheduled,
        shard,
        setReachable: (next: boolean) => {
            failure = next ? undefined : new Error("SchedulerDO unreachable");
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

        register("outbox:orderPlacedForever", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "forever", ownerId: "u1" });

            const jobId = await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "o-2" }, { retry: { forever: true } });

            return { jobId, ok: true };
        });

        register("outbox:twoJobs", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "two", ownerId: "u1" });
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "first" });
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "second" });

            return { ok: true };
        });

        register("outbox:sameId", "mutation", async (ctx) => {
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "a" }, { id: "dup-id" });
            await ctx.scheduler.runAfter(0, { __lunoraRef: "outbox:charge" }, { orderId: "b" }, { id: "dup-id" });

            return { ok: true };
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

    it("keeps an operator's Retry now when an attempt already in flight fails afterwards", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const { entered, release } = harness.hold();

        harness.makeDue();

        const attempt = harness.retry();

        await entered;
        await harness.shard.requeue(id);
        release();
        await attempt;

        // The reset stands: the stale attempt neither counted itself nor pushed the entry out.
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 0, id }]);
        expect(harness.logs("scheduler:outbox")).toStrictEqual([]);
    });

    it("does not let a stale attempt overwrite the reset of a newer one", async () => {
        expect.assertions(2);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const older = harness.hold();

        harness.makeDue();

        const olderAttempt = harness.retry();

        await older.entered;
        await harness.shard.requeue(id);

        const newer = harness.hold();

        harness.makeDue();

        const newerAttempt = harness.retry();

        await newer.entered;
        older.release();
        await olderAttempt;

        // The older attempt failed after the operator's reset and while a newer attempt was awaiting: it must write nothing.
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 0, id }]);

        newer.release();
        await newerAttempt;
    });

    it("cancels at the scheduler when an entry is dropped, in case it already holds the job", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        await harness.drop(id);

        expect(harness.outbox()).toStrictEqual([]);
        expect(harness.cancelled).toStrictEqual([id]);
    });

    it("stops handing an entry over when the scheduler cannot be asked to cancel it", async () => {
        expect.assertions(5);

        const harness = createHarness();

        harness.setReachable(false);
        harness.failCancel(new Error("SchedulerDO unreachable"));

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        // The scheduler is down, so the cancel cannot be confirmed: the drop reports that, and the entry must not run anyway.
        await expect(harness.drop(id)).rejects.toThrow("SchedulerDO unreachable");
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);

        harness.setReachable(true);
        harness.makeDue();
        await harness.retry();

        expect(harness.scheduled).toStrictEqual([]);

        // Once the scheduler answers, the same drop completes.
        harness.failCancel(undefined);
        await harness.drop(id);

        expect(harness.outbox()).toStrictEqual([]);
    });

    it("cancels the job when an entry is dropped while its hand-off is still awaiting the scheduler", async () => {
        expect.assertions(4);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const { entered, release } = harness.hold();

        harness.setReachable(true);
        harness.makeDue();

        const attempt = harness.retry();

        await entered;
        await harness.drop(id);
        release();
        await attempt;

        // The scheduler accepted the call the drop raced: the drop has to take it back out.
        expect(harness.scheduled.map((job) => job.id)).toContain(id);
        expect(harness.cancelled.at(-1)).toBe(id);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("keeps the row parked when a job that landed during a drop cannot be cancelled either", async () => {
        expect.assertions(4);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const { entered, release } = harness.hold();

        harness.setReachable(true);
        harness.makeDue();

        const attempt = harness.retry();

        await entered;
        harness.failCancel(new Error("cancel refused"));

        await expect(harness.drop(id)).rejects.toThrow("cancel refused");

        release();
        await attempt;

        // The scheduler took the job and neither cancel was confirmed: the entry has to survive so a later drop can finish it.
        expect(harness.scheduled.map((job) => job.id)).toContain(id);
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);
    });

    it("keeps the row parked when a drop's own cancel worked but the landing job's cancel fails", async () => {
        expect.assertions(2);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const { entered, release } = harness.hold();

        harness.setReachable(true);
        harness.makeDue();

        const attempt = harness.retry();

        await entered;
        await harness.drop(id);
        harness.failCancel(new Error("cancel refused"));
        release();
        await attempt;

        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);
    });

    it("audits a Retry now whose alarm could not be armed, and a drop whose cancel failed", async () => {
        expect.assertions(4);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        harness.failAlarms(true);

        await expect(harness.shard.requeue(id)).rejects.toThrow("alarm refused");

        harness.failCancel(new Error("cancel refused"));

        await expect(harness.drop(id)).rejects.toThrow("cancel refused");

        expect(harness.audit().map((entry) => `${entry.op}:${String((JSON.parse(entry.detail ?? "{}") as { outcome?: string }).outcome)}`)).toStrictEqual([
            "retryOutboxEntry:failed",
            "dropOutboxEntry:parked",
        ]);
    });

    it("cancels a job that lands from the FIRST post-commit hand-off after the entry was dropped", async () => {
        expect.assertions(4);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:orderPlaced", {});

        // The mutation committed and its first hand-off is waiting on a slow scheduler.
        await entered;

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        await expect(harness.drop(id).then(async (response) => response.json())).resolves.toStrictEqual({ result: { dropped: true } });

        release();
        await rpc;

        // The job landed after the drop, so only a cancel issued after it landed can stop it.
        expect(harness.scheduled.map((job) => job.id)).toContain(id);
        expect(harness.cancelOutcomes.at(-1)).toBe(true);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("refuses a Retry now for an entry whose drop is still cancelling", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const { entered, release } = harness.holdCancel();
        const drop = harness.drop(id);

        await entered;

        await expect(harness.shard.requeue(id).then(async (response) => response.json())).resolves.toStrictEqual({ result: { retried: false } });

        release();
        await drop;

        expect(harness.outbox()).toStrictEqual([]);
    });

    it("cancels a job whose hand-off was rejected after a drop, since the accept may have been lost", async () => {
        expect.assertions(4);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:orderPlaced", {});

        await entered;

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        await harness.drop(id);
        harness.cancelled.length = 0;
        harness.failWith(new Error("response lost"));
        release();

        await expect(rpc).rejects.toThrow("response lost");

        expect(harness.cancelled).toStrictEqual([id]);
        expect(harness.outbox()).toStrictEqual([]);

        // A cancel that cannot be confirmed keeps the entry, parked, instead of forgetting a job that may run.
        const second = createHarness();
        const held = second.hold();
        const secondRpc = second.shard.handleRpc("outbox:orderPlaced", {});

        await held.entered;

        const secondId = second.outbox()[0]?.id ?? "<no entry>";

        await second.drop(secondId);
        second.failCancel(new Error("cancel refused"));
        second.failWith(new Error("response lost"));
        held.release();
        await secondRpc.catch(() => undefined);

        expect(second.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id: secondId }]);
    });

    it("does not fail a committed mutation when the bookkeeping after an accepted hand-off throws", async () => {
        expect.assertions(3);

        const harness = createHarness();

        // The table is created by shard init, which the first dispatch runs.
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        harness.run("CREATE TRIGGER outbox_delete_down BEFORE DELETE ON __schedule_outbox BEGIN SELECT RAISE(ABORT, 'bookkeeping down'); END");

        // The scheduler accepted the job; a failed delete of the custody row must not turn that into an error.
        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).resolves.toMatchObject({ ok: true });

        expect(harness.scheduled).toHaveLength(1);
    });

    it("parks rather than deletes a dropped entry when no scheduler is left to confirm the cancel", async () => {
        expect.assertions(3);

        const harness = createHarness({ scheduler: false });

        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        harness.run(
            "INSERT INTO __schedule_outbox (id, envelope_json, attempts, next_attempt_at, created_at, dead) VALUES (?, ?, 3, 0, ?, 0)",
            "job-1",
            JSON.stringify({ args: {}, options: undefined, target: { __lunoraRef: "outbox:charge" }, when: 0 }),
            Date.now(),
        );

        // The job may have been accepted before the binding went away: the drop cannot claim it is stopped.
        await expect(harness.drop("job-1")).rejects.toThrow(/cancel/u);
        expect(harness.outbox()).toStrictEqual([{ attempts: 3, dead: 1, id: "job-1" }]);
    });

    it("never hands a dropped entry to the scheduler when its hand-off had not started", async () => {
        expect.assertions(3);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:twoJobs", {});

        // The first hand-off is awaiting the scheduler; the second has not started.
        await entered;

        const first = harness.received[0]?.id;
        const second = harness.outbox().find((entry) => entry.id !== first)?.id ?? "<no entry>";

        await harness.drop(second);
        release();
        await rpc;

        expect(harness.scheduled.map((job) => job.id)).toStrictEqual([first]);
        expect(harness.received).toHaveLength(1);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("sends both calls of a mutation that reuses an explicit job id, leaving the duplicate to the scheduler", async () => {
        expect.assertions(2);

        const harness = createHarness();

        await expect(harness.shard.handleRpc("outbox:sameId", {})).resolves.toMatchObject({ ok: true });

        // The first hand-off released the shared custody row; the second is not a dropped entry and must still be offered.
        expect(harness.received.map((options) => options?.id)).toStrictEqual(["dup-id", "dup-id"]);
    });

    it("offers a job again when its id is scheduled anew after an earlier entry with that id was dropped", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        await harness.drop("dup-id");
        harness.setReachable(true);
        harness.received.length = 0;

        await expect(harness.shard.handleRpc("outbox:sameId", {})).resolves.toMatchObject({ ok: true });

        expect(harness.received).toHaveLength(2);
    });

    it("does not undo a Retry now with the drop that an in-flight attempt still carries", async () => {
        expect.assertions(4);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:orderPlaced", {});

        await entered;

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        await harness.drop(id);

        await expect(harness.shard.requeue(id).then(async (response) => response.json())).resolves.toStrictEqual({ result: { retried: true } });

        harness.cancelOutcomes.length = 0;
        release();
        await rpc;

        // The operator asked for the job after all: the landed job must stand, and the entry is released normally.
        expect(harness.scheduled.map((job) => job.id)).toContain(id);
        expect(harness.cancelOutcomes).not.toContain(true);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("does not let a sibling call with the same id reschedule a job dropped while in flight", async () => {
        expect.assertions(3);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:sameId", {});

        await entered;
        await harness.drop("dup-id");
        release();
        await rpc;

        // The first call landed and was cancelled; the second is the same dropped job and must not start it again.
        expect(harness.received).toHaveLength(1);
        expect(harness.cancelOutcomes.at(-1)).toBe(true);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("leaves a job scheduled anew under the same id alone when the drop that was cancelling the old one finishes", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        const { entered, release } = harness.holdCancel();
        const drop = harness.drop("dup-id");

        await entered;
        harness.setReachable(true);
        harness.received.length = 0;

        // A new mutation schedules under the same explicit id while the drop awaits the scheduler.
        const replacement = harness.shard.handleRpc("outbox:sameId", {});

        // Its hand-offs wait for the drop that is still cancelling, so the drop is released first.
        release();
        await drop;
        await replacement;

        // The new row is a different entry: it was handed off, not skipped and not deleted by the old drop.
        expect(harness.received).toHaveLength(2);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("reports a drop as failed when an attempt that landed during it could not cancel the job", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const landing = harness.hold();

        harness.setReachable(true);
        harness.makeDue();

        const attempt = harness.retry();

        await landing.entered;

        const cancelling = harness.holdCancel();
        const drop = harness.drop(id);

        await cancelling.entered;
        // The job lands while the drop is cancelling; the attempt's own cancel is refused and parks the row.
        harness.failCancel(new Error("cancel refused"));
        landing.release();
        await attempt;
        harness.failCancel(undefined);
        cancelling.release();

        // The drop's cancel worked, but a job that may still run was left parked: that is not a success.
        await expect(drop).rejects.toThrow(/may still run|cancel/u);
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);
    });

    it("reports a drop as failed when its cancel failed, even if the entry was replaced meanwhile", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        const { entered, release } = harness.holdCancel();
        const drop = harness.drop("dup-id");

        await entered;
        harness.failCancel(new Error("cancel refused"));
        harness.setReachable(true);

        const stamp = (): string =>
            JSON.stringify((harness.run("SELECT created_at FROM __schedule_outbox WHERE id = 'dup-id'") as { toArray: () => unknown[] }).toArray()[0]);
        const before = stamp();
        const replacement = harness.shard.handleRpc("outbox:sameId", {});

        await vi.waitFor(() => {
            if (stamp() === before) {
                throw new Error("the replacement has not recorded yet");
            }
        });
        release();

        // The old job may still run (its cancel was refused); the replacement is a different schedule and stays untouched.
        await expect(drop).rejects.toThrow("cancel refused");

        await replacement;

        expect(harness.outbox()).toStrictEqual([]);
    });

    it("does not defer or park a replacement row when the attempt it replaced fails afterwards", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        const { entered, release } = harness.hold();

        harness.makeDue();

        const attempt = harness.retry();

        await entered;

        // Scheduled anew under the same id while the old attempt is awaiting the scheduler.
        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        release();
        await attempt;

        // The old attempt's failure says nothing about the new row.
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 0, id: "dup-id" }]);
    });

    it("skips the queued call of a dropped schedule even after another mutation reuses its id, and hands that one off", async () => {
        expect.assertions(3);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const first = harness.shard.handleRpc("outbox:sameId", {});

        // The first mutation's first call is awaiting the scheduler; its second call is still queued.
        await entered;
        await harness.drop("dup-id");

        // A second mutation reuses the id after the drop: new custody, never covered by that drop.
        await harness.shard.handleRpc("outbox:sameId", {});
        release();
        await first;

        // First mutation: one call (it landed and was cancelled); the dropped second call never went out.
        // Second mutation: both of its calls.
        expect(harness.received).toHaveLength(3);
        expect(harness.cancelOutcomes).toContain(true);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("keeps the row parked when the scheduler reports it no longer holds a job that just landed", async () => {
        expect.assertions(3);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const rpc = harness.shard.handleRpc("outbox:orderPlaced", {});

        await entered;

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        await harness.drop(id);
        // The landed job already ran, so the scheduler answers { cancelled: false }: the drop did not stop it.
        harness.refuseCancels(true);
        release();
        await rpc;

        expect(harness.scheduled.map((job) => job.id)).toContain(id);
        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);
        expect(harness.logs("scheduler:outbox").some((entry) => entry.level === "error")).toBe(true);
    });

    it("still skips the queued call of a dropped schedule after more than a thousand other drops", async () => {
        expect.assertions(2);

        const harness = createHarness();
        const { entered, release } = harness.hold();
        const first = harness.shard.handleRpc("outbox:sameId", {});

        await entered;
        await harness.drop("dup-id");

        for (let index = 0; index < 1100; index += 1) {
            harness.run(
                "INSERT INTO __schedule_outbox (id, envelope_json, attempts, next_attempt_at, created_at, dead) VALUES (?, ?, 0, 0, ?, 0)",
                `other-${String(index)}`,
                JSON.stringify({ args: {}, options: undefined, target: { __lunoraRef: "outbox:charge" }, when: 0 }),
                1,
            );
            // eslint-disable-next-line no-await-in-loop -- each drop must settle before the next, as separate operator calls do
            await harness.drop(`other-${String(index)}`);
        }

        release();
        await first;

        // Only the first call of the first mutation went out; the dropped second one stays dropped.
        expect(harness.received.filter((options) => options?.id === "dup-id")).toHaveLength(1);
        expect(harness.outbox()).toStrictEqual([]);
    });

    it("sends a replacement's hand-off only after the drop that was cancelling the old job settled", async () => {
        expect.assertions(2);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:sameId", {})).rejects.toThrow("2 of 2 deferred jobs failed");

        const { entered, release } = harness.holdCancel();
        const drop = harness.drop("dup-id");

        await entered;
        harness.setReachable(true);
        harness.order.length = 0;

        const stamp = (): unknown => (harness.run("SELECT created_at FROM __schedule_outbox WHERE id = 'dup-id'") as { toArray: () => unknown[] }).toArray()[0];
        const before = JSON.stringify(stamp());
        const replacement = harness.shard.handleRpc("outbox:sameId", {});

        // The replacement has committed and recorded its custody; its hand-offs are what must still be waiting.
        await vi.waitFor(() => {
            if (JSON.stringify(stamp()) === before) {
                throw new Error("the replacement has not recorded yet");
            }
        });
        // A negative assertion has no event to wait on: let everything the replacement can do on its own run.
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        release();
        await drop;
        await replacement;

        // An id-only cancel that is still in flight must not meet the replacement at the scheduler.
        expect(harness.order).toStrictEqual(["cancel-done", "run", "run"]);
    });

    it("keeps excluding the entry while any of two overlapping drops is still in flight", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";
        const firstGate = harness.holdCancel();
        const firstDrop = harness.drop(id).catch(() => undefined);

        await firstGate.entered;

        const secondGate = harness.holdCancel();
        const secondDrop = harness.drop(id).catch(() => undefined);

        await secondGate.entered;
        harness.failCancel(new Error("cancel refused"));
        firstGate.release();
        await firstDrop;

        // The second drop is still cancelling: a Retry now must not be accepted yet.
        await expect(harness.shard.requeue(id).then(async (response) => response.json())).resolves.toStrictEqual({ result: { retried: false } });

        secondGate.release();
        await secondDrop;

        expect(harness.outbox()).toStrictEqual([{ attempts: 0, dead: 1, id }]);
    });

    it("does not hand a dropped entry to the scheduler when it was already queued in the same batch", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");
        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const [first, second] = harness.outbox().map((entry) => entry.id);
        const { entered, release } = harness.hold();

        harness.setReachable(true);
        // The tick takes due rows by next attempt, so pin the order the test relies on.
        harness.run("UPDATE __schedule_outbox SET next_attempt_at = 1 WHERE id = ?", first);
        harness.run("UPDATE __schedule_outbox SET next_attempt_at = 2 WHERE id = ?", second);

        const attempt = harness.retry();

        await entered;
        // The batch snapshot already holds `second`; the operator drops it while `first` awaits.
        await harness.drop(second ?? "");
        release();
        await attempt;

        expect(harness.scheduled.map((job) => job.id)).toStrictEqual([first]);
    });

    it("arms the alarm for a Retry now even when the in-memory alarm time is stale, and before auditing", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlaced", {})).rejects.toThrow("SchedulerDO unreachable");

        const id = harness.outbox()[0]?.id ?? "<no entry>";

        // An earlier alarm the instance believes is pending, which a failed init may never have delivered.
        Object.assign(harness.shard, {
            globalPollArmedAt: 1,
            recordAudit: () => {
                throw new Error("audit store unavailable");
            },
        });
        harness.alarms.length = 0;

        await expect(harness.shard.requeue(id)).rejects.toThrow("audit store unavailable");

        expect(harness.alarms.length).toBeGreaterThan(0);
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

/**
 * The schedule-rate budget on the same real dispatch. The facade's `admit` is the
 * generated `buildCtx`'s `this.scheduleOutbox()`, which is `ShardDO`'s own
 * `admitScheduleRate`, so a loop and a fan-out here exercise the shipped admission
 * hook and the shipped facade together. The scheduler stub only records the delay it
 * was handed, which is the one thing the deferral changes.
 */
describe("emitted shard — the schedule-rate budget on the real dispatch", () => {
    /** The default `LUNORA_SCHEDULE_RATE_LIMIT`, per target per shard per window. */
    const DEFAULT_LIMIT = 600;
    /** A deferral moves a job one window out (60 000 ms, plus one millisecond). */
    const DEFERRED_MIN_MS = 60_000;
    /** More jobs than the default limit, from one invocation: one budget unit, not a deferral. */
    const FAN_OUT = 1000;
    const NOW = 1_700_000_000_000;

    /** Each job the scheduler was asked to run, with the delay it was handed. */
    let dispatched: { delayMs: number; target: unknown }[];

    /** The slice of the generated shard this suite calls. */
    let shard: { handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown> };

    beforeAll(() => {
        // Schedules itself: each invocation is one more iteration of the loop.
        register("rate:step", "mutation", async (ctx) => {
            await ctx.scheduler.runAfter(0, { __lunoraRef: "rate:step" }, {});

            return { ok: true };
        });

        register("rate:fanOut", "mutation", async (ctx) => {
            for (let job = 0; job < FAN_OUT; job += 1) {
                // eslint-disable-next-line no-await-in-loop -- one invocation's jobs are scheduled in declaration order
                await ctx.scheduler.runAfter(0, { __lunoraRef: "rate:job" }, { job });
            }

            return { ok: true };
        });
    });

    beforeEach(() => {
        // A fixed clock: every invocation lands in one window, so the count is exact.
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        dispatched = [];

        const ShardClass = createShardDO({
            scheduler: () => {
                return {
                    cancel: () => Promise.resolve({ cancelled: false }),
                    runAfter: (delayMs: number, target: unknown): Promise<string> => {
                        dispatched.push({ delayMs, target });

                        return Promise.resolve("job");
                    },
                    runAt: (timestampMs: number, target: unknown): Promise<string> => {
                        dispatched.push({ delayMs: timestampMs - Date.now(), target });

                        return Promise.resolve("job");
                    },
                };
            },
        });

        const { state } = createState([], { fail: false });

        shard = new (ShardClass as unknown as new (state: unknown, env: unknown) => typeof shard)(state, {});
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("defers a self-loop once the target's budget is spent, and runs the rest of it a window later", async () => {
        expect.assertions(3);

        const invocations = DEFAULT_LIMIT + 50;

        for (let call = 0; call < invocations; call += 1) {
            // eslint-disable-next-line no-await-in-loop -- each invocation settles before the next, as the runtime serializes dispatches
            await shard.handleRpc("rate:step", {});
        }

        const delays = dispatched.map((job) => job.delayMs);

        expect(delays).toHaveLength(invocations);
        expect(delays.filter((delayMs) => delayMs === 0)).toHaveLength(DEFAULT_LIMIT);
        expect(delays.filter((delayMs) => delayMs >= DEFERRED_MIN_MS)).toHaveLength(invocations - DEFAULT_LIMIT);
    });

    it("never defers a one-invocation fan-out, however many jobs it schedules", async () => {
        expect.assertions(2);

        await shard.handleRpc("rate:fanOut", {});

        const delays = dispatched.map((job) => job.delayMs);

        expect(delays).toHaveLength(FAN_OUT);
        expect(delays.every((delayMs) => delayMs === 0)).toBe(true);
    });
});

describe("emitted shard — a retry.forever deferred schedule", () => {
    /** Drive `count` retry attempts, each made due first. */
    const drive = async (harness: Harness, count: number): Promise<void> => {
        for (let attempt = 0; attempt < count; attempt += 1) {
            harness.makeDue();
            // eslint-disable-next-line no-await-in-loop -- each attempt reads the row the previous one wrote
            await harness.retry();
        }
    };

    it("stays live past the attempt ceiling and warns once when it passes it", async () => {
        expect.assertions(4);

        const harness = createHarness();

        harness.setReachable(false);

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("SchedulerDO unreachable");

        await drive(harness, 12);

        expect(harness.outbox()).toStrictEqual([{ attempts: 12, dead: 0, id: expect.any(String) }]);
        expect(harness.logs("scheduler:outbox")).toStrictEqual([
            { level: "warn", message: expect.stringContaining("still waiting for the scheduler after 8 attempts") },
        ]);

        // The policy travels with the replay, so the scheduler retries it the same way once it has it.
        harness.setReachable(true);
        await drive(harness, 1);

        expect(harness.received.at(-1)).toStrictEqual({ id: expect.any(String), retry: { forever: true } });
    });

    it("parks on a refusal no retry can change", async () => {
        expect.assertions(3);

        const harness = createHarness();

        harness.failWith(new LunoraError("INVALID_INPUT", "bad args"));

        await expect(harness.shard.handleRpc("outbox:orderPlacedForever", {})).rejects.toThrow("bad args");

        await drive(harness, 1);

        expect(harness.outbox()).toStrictEqual([{ attempts: 1, dead: 1, id: expect.any(String) }]);
        expect(harness.logs("scheduler:outbox")).toStrictEqual([
            { level: "error", message: expect.stringContaining("the scheduler refused the stored call: INVALID_INPUT") },
        ]);
    });

    it("waits in custody on a shard with no scheduler instead of parking", async () => {
        expect.assertions(3);

        const harness = createHarness({ scheduler: false });

        // The table is created by shard init, which the first dispatch runs.
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        const envelope = JSON.stringify({ args: {}, options: { retry: { forever: true } }, target: { __lunoraRef: "outbox:charge" }, when: 0 });

        harness.run(
            "INSERT INTO __schedule_outbox (id, envelope_json, attempts, next_attempt_at, created_at, dead) VALUES (?, ?, 0, 0, ?, 0)",
            "job-1",
            envelope,
            Date.now(),
        );
        await drive(harness, 3);

        expect(harness.outbox()).toStrictEqual([{ attempts: 3, dead: 0, id: "job-1" }]);
        expect(harness.logs("scheduler:outbox")).toStrictEqual([]);
    });

    it("parks a stored call that can never become a job", async () => {
        expect.assertions(3);

        const harness = createHarness();

        // The table is created by shard init, which the first dispatch runs.
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        const envelope = JSON.stringify({ args: {}, options: { retry: { forever: true } }, target: { notAReference: true }, when: 0 });

        harness.run(
            "INSERT INTO __schedule_outbox (id, envelope_json, attempts, next_attempt_at, created_at, dead) VALUES (?, ?, 0, 0, ?, 0)",
            "job-2",
            envelope,
            Date.now(),
        );
        await drive(harness, 1);

        expect(harness.outbox()).toStrictEqual([{ attempts: 1, dead: 1, id: "job-2" }]);
        expect(harness.received).toStrictEqual([]);
    });

    /** Put one hand-written envelope in custody, due now, on a freshly initialised shard. */
    const seed = async (harness: Harness, id: string, envelope: Record<string, unknown>): Promise<void> => {
        // The table is created by shard init, which the first dispatch runs.
        await expect(harness.shard.handleRpc("outbox:countNotes", {})).resolves.toBe(0);

        harness.run(
            "INSERT INTO __schedule_outbox (id, envelope_json, attempts, next_attempt_at, created_at, dead) VALUES (?, ?, 0, 0, ?, 0)",
            id,
            JSON.stringify(envelope),
            Date.now(),
        );
    };

    it("replays a workflow whose params are not an object", async () => {
        expect.assertions(3);

        const harness = createHarness();

        await seed(harness, "job-3", {
            args: [1, 2],
            options: { retry: { forever: true } },
            target: { className: "ImportWorkflow", isLunoraWorkflow: true },
            when: 0,
        });
        await drive(harness, 1);

        expect(harness.outbox()).toStrictEqual([]);
        expect(harness.scheduled.map((job) => job.args)).toStrictEqual([[1, 2]]);
    });

    it("parks a workflow-branded target with no class, whatever reference it also carries", async () => {
        expect.assertions(3);

        const harness = createHarness();

        await seed(harness, "job-4", { args: {}, target: { __lunoraRef: "outbox:charge", isLunoraWorkflow: true }, when: 0 });
        await drive(harness, 1);

        expect(harness.outbox()).toStrictEqual([{ attempts: 1, dead: 1, id: "job-4" }]);
        expect(harness.received).toStrictEqual([]);
    });

    it("names the target and the reason when a readable envelope cannot be replayed", async () => {
        expect.assertions(2);

        const harness = createHarness();

        await seed(harness, "job-5", { args: {}, target: { __lunoraRef: "outbox:charge" } });
        await drive(harness, 1);

        expect(harness.logs("scheduler:outbox")).toStrictEqual([
            {
                level: "error",
                message: expect.stringMatching(/job-5 \(target \{"__lunoraRef":"outbox:charge"\}\) will not be enqueued: its fire time is missing/u),
            },
        ]);
    });
});
