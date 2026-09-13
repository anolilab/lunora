import type { SchemaLike, SqlExec, WriteEvent } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { body: { kind: "string" } },
        },
    },
};

let database: ReturnType<typeof createSqliteExec>;

const makeState = (): ShardDOState =>
    ({
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        id: { name: "shard-a" },
        storage: {
            sql: database.sql as unknown as ShardDOState["storage"]["sql"],
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                database.raw("BEGIN");

                try {
                    const value = await closure();

                    database.raw("COMMIT");

                    return value;
                } catch (error) {
                    database.raw("ROLLBACK");

                    throw error;
                }
            },
        },
    }) as unknown as ShardDOState;

class WriteHookShard extends ShardDO {
    public readonly events: WriteEvent[] = [];

    /** Makes the hook throw, standing in for Vectorize being unreachable after the commit. */
    public failHook = false;

    public constructor(state: ShardDOState) {
        super(state, {});
    }

    // eslint-disable-next-line class-methods-use-this -- override stub; this suite drives transactions directly
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    public writer(): ReturnType<typeof createShardCtxDb> {
        return createShardCtxDb({
            broadcast: () => undefined,
            inTransaction: () => this.isInTransaction(),
            // Exactly how the emitter wires the vector-sync hook: held until the
            // transaction commits, run inline when none is open.
            onWrite: (event) =>
                this.deferAfterCommit(() => {
                    this.events.push(event);

                    if (this.failHook) {
                        throw new Error("vectorize unreachable");
                    }
                }),
            schema,
            sql: this.sql as SqlExec,
        });
    }

    public run<T>(handler: () => Promise<T> | T): Promise<T> {
        return this.runInTransaction(handler);
    }
}

describe("shardDO.runInTransaction — external write hooks", () => {
    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, schema);
    });

    afterEach(() => {
        database.close();
    });

    it("does not fire onWrite for an insert whose transaction rolls back", async () => {
        expect.assertions(2);

        const shard = new WriteHookShard(makeState());
        const db = shard.writer();

        await expect(
            shard.run(async () => {
                await db.insert("notes", { body: "doomed" });

                throw new Error("boom after insert");
            }),
        ).rejects.toThrow("boom after insert");

        expect(shard.events).toStrictEqual([]);
    });

    it("does not fire onWrite for an update whose transaction rolls back", async () => {
        expect.assertions(2);

        const shard = new WriteHookShard(makeState());
        const db = shard.writer();
        const id = await shard.run(async () => db.insert("notes", { body: "kept" }));

        shard.events.length = 0;

        await expect(
            shard.run(async () => {
                await db.patch(id, { body: "doomed" });

                throw new Error("boom after patch");
            }),
        ).rejects.toThrow("boom after patch");

        expect(shard.events).toStrictEqual([]);
    });

    it("does not fire onWrite for a delete whose transaction rolls back", async () => {
        expect.assertions(2);

        const shard = new WriteHookShard(makeState());
        const db = shard.writer();
        const id = await shard.run(async () => db.insert("notes", { body: "kept" }));

        shard.events.length = 0;

        await expect(
            shard.run(async () => {
                await db.delete(id);

                throw new Error("boom after delete");
            }),
        ).rejects.toThrow("boom after delete");

        expect(shard.events).toStrictEqual([]);
    });

    it("fires onWrite once the transaction has committed", async () => {
        expect.assertions(2);

        const shard = new WriteHookShard(makeState());
        const db = shard.writer();

        const id = await shard.run(async () => db.insert("notes", { body: "kept" }));

        expect(shard.events).toHaveLength(1);
        expect(shard.events[0]).toMatchObject({ id, op: "insert", table: "notes" });
    });

    it("fires onWrite inline when no transaction is open (an action)", async () => {
        expect.assertions(2);

        const shard = new WriteHookShard(makeState());
        const db = shard.writer();

        const id = await db.insert("notes", { body: "unwrapped" });

        expect(shard.events).toHaveLength(1);
        expect(shard.events[0]).toMatchObject({ id, op: "insert", table: "notes" });
    });

    it("keeps the committed row when the post-commit hook fails, and reports it", async () => {
        expect.assertions(3);

        const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const shard = new WriteHookShard(makeState());
        const db = shard.writer();

        shard.failHook = true;

        // The write COMMITTED. A post-commit hook failure must not present as a
        // failed mutation — a caller retrying a non-idempotent insert on that
        // error writes the row twice.
        const id = await shard.run(async () => db.insert("notes", { body: "kept" }));

        await expect(db.get(id)).resolves.toMatchObject({ body: "kept" });
        expect(reported).toHaveBeenCalledTimes(1);
        expect(reported.mock.calls[0]?.[0]).toContain("after-commit write hook failed");

        reported.mockRestore();
    });
});
