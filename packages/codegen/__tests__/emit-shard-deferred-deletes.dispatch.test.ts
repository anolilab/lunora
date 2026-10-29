/**
 * `ctx.storage.deleteAfterCommit(key)` driven through the REAL dispatch, not
 * through assertions on the emitted string.
 *
 * Every other suite around the emitter asserts on substrings of the generated
 * text, and the sibling `emit-shard-deferred-deletes.test.ts` says why that is
 * usually enough. It is not enough here: the defect this suite exists to pin was
 * a placement fact that read correctly in every one of those assertions — the
 * flush IS outside the transaction and every dispatch that installs the queue
 * DOES drain it — and still deleted an object whose row had been rolled back,
 * because the queue could not tell a composed mutation's keys from its caller's.
 * Only running it shows that.
 *
 * So this suite drives the committed golden `_generated/shard.ts`
 * (`fixtures/delta-sync`, the same tree `delta-sync.test.ts` snapshots) against
 * the real `@lunora/do` base class and the real `@lunora/server` deferral
 * modules, on Node's own SQLite. The pieces that are doubles are the HOST's:
 * `storage.transaction` (BEGIN/ROLLBACK on `node:sqlite`, the semantics workerd
 * gives `state.storage.transaction`) and the R2 bucket, which records the keys
 * it was asked to delete. The dispatch itself — `handleRpc`, `buildCtx`,
 * `dispatchRun`, `runMutationTransaction` — is generated code, executed.
 *
 * Handlers are registered by writing into the golden's own `LUNORA_FUNCTIONS`
 * table, which is how the emitted dispatch finds every function it runs.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

/** The slice of a dispatch ctx these handlers touch. */
interface TestCtx {
    db: { insert: (table: string, row: Record<string, unknown>) => Promise<unknown>; query: (table: string) => { collect: () => Promise<unknown[]> } };
    runMutation: (reference: { __lunoraRef: string }, args: Record<string, unknown>) => Promise<unknown>;
    storage: { deleteAfterCommit: (key: string) => void };
}

/**
 * The DO state the shard is constructed with.
 *
 * `transaction` is the host primitive `ShardHost.transaction` delegates to — the
 * one that makes a failed handler roll back. Implemented here with real
 * BEGIN/ROLLBACK so the rollback under test is a rollback and not an assumption;
 * a state without it falls through to a bare call (see `cloudflare-host.ts`) and
 * every assertion below would pass for the wrong reason.
 */
const createState = (): unknown => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
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
    };
};

/** A shard whose storage records the deletes it was asked to perform. */
const createShard = (): { deleted: string[]; shard: { handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown> } } => {
    const deleted: string[] = [];
    const ShardClass = createShardDO({
        storage: () => {
            return {
                delete: async (key: string): Promise<void> => {
                    deleted.push(key);
                },
            };
        },
    });

    return { deleted, shard: new ShardClass(createState() as never, {}) };
};

const register = (path: string, kind: "action" | "mutation" | "query", handler: (ctx: TestCtx) => unknown): void => {
    (LUNORA_FUNCTIONS as unknown as Record<string, unknown>)[path] = { args: {}, handler, kind };
};

describe("emitted shard — deferred deletes across a rolled-back composition", () => {
    beforeAll(() => {
        // A mutation that queues an object delete and then fails — an OCC
        // conflict, an RLS denial, a validator, a failed row halfway through a
        // batch all land here.
        register("deferred:rollback", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "doomed", ownerId: "u1" });

            ctx.storage.deleteAfterCommit("avatars/rolled-back.png");

            throw new Error("boom after deleteAfterCommit");
        });

        register("deferred:commit", "mutation", async (ctx) => {
            await ctx.db.insert("notes", { boardId: "b1", body: "kept", ownerId: "u1" });

            ctx.storage.deleteAfterCommit("avatars/committed.png");
        });

        // The documented shape: do the I/O in an action, persist in a mutation —
        // and swallow the mutation's failure.
        register("deferred:actionOverRollback", "action", async (ctx) => {
            ctx.storage.deleteAfterCommit("avatars/action-own.png");

            try {
                await ctx.runMutation({ __lunoraRef: "deferred:rollback" }, {});
            } catch (error) {
                return `caught: ${(error as Error).message}`;
            }

            return "no throw";
        });

        register("deferred:actionOverCommit", "action", async (ctx) => {
            await ctx.runMutation({ __lunoraRef: "deferred:commit" }, {});

            return "ok";
        });

        // `ctx.runMutation` from INSIDE a mutation: no savepoints, so the inner
        // dispatch rides the enclosing span.
        register("deferred:outerOverInnerRollback", "mutation", async (ctx) => {
            ctx.storage.deleteAfterCommit("avatars/outer.png");

            try {
                await ctx.runMutation({ __lunoraRef: "deferred:rollback" }, {});
            } catch {
                // swallowed, exactly as the action does
            }
        });

        register("deferred:countNotes", "query", async (ctx) => {
            const rows = await ctx.db.query("notes").collect();

            return rows.length;
        });
    });

    it("keeps the object when a mutation composed from an action rolls back", async () => {
        expect.assertions(3);

        const { deleted, shard } = createShard();

        await expect(shard.handleRpc("deferred:actionOverRollback", {})).resolves.toBe("caught: boom after deleteAfterCommit");

        // The span really rolled back — the row the mutation wrote is gone. Without
        // this the delete assertion below could pass on a harness that never opened
        // a transaction at all.
        await expect(shard.handleRpc("deferred:countNotes", {})).resolves.toBe(0);

        // ...and the object the rolled-back mutation queued is still there, while
        // the action's OWN queued key — which belongs to no transaction — is
        // flushed as it always was. Deleting the first one destroys the object a
        // surviving row still points at, which is the loss this facility exists to
        // prevent.
        expect(deleted).toStrictEqual(["avatars/action-own.png"]);
    });

    it("still deletes when the composed mutation commits", async () => {
        expect.assertions(3);

        const { deleted, shard } = createShard();

        await expect(shard.handleRpc("deferred:actionOverCommit", {})).resolves.toBe("ok");
        await expect(shard.handleRpc("deferred:countNotes", {})).resolves.toBe(1);
        expect(deleted).toStrictEqual(["avatars/committed.png"]);
    });

    it("drops only the failed inner window when a nested mutation throws inside a committing one", async () => {
        expect.assertions(2);

        const { deleted, shard } = createShard();

        await expect(shard.handleRpc("deferred:outerOverInnerRollback", {})).resolves.toBeUndefined();

        // The inner dispatch shares the enclosing span, so its ROWS are not rolled
        // back by its own throw — but its keys are still dropped. Erring toward a
        // leaked object is the only safe direction: a delete cannot be undone, and
        // the outer handler swallowed the error, so nothing knows what landed.
        expect(deleted).toStrictEqual(["avatars/outer.png"]);
    });
});
