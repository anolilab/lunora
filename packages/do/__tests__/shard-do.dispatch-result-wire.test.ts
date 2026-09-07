import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The shard half of the dispatch RESULT wire — the encoder side of the bracket
 * `@lunora/dispatch`'s `dispatch-result-wire.test.ts` closes.
 *
 * Two things are pinned here, and both are contracts the runner now depends on.
 *
 * First, the result is wire-ENCODED exactly once, by `encodeWire`. The runner is
 * the single decoder, and `decodeWire` is not idempotent — a second encode/decode
 * pass flattens a `Date` to `{}` while a `bigint` survives, so a drift here is
 * silent for exactly the type nothing would catch.
 *
 * Second, it travels inside an ENVELOPE — `{ result }`, `{ commitCursor, result }`
 * for a mutation on a CDC-enabled shard, or `{ lastMutationId, result }` for a
 * `"next"` custom-mutator push (also pinned by
 * `shard-do.client-watermark.test.ts`, which asserts the envelope on a pure-JSON
 * result). The runner unwraps `result` and drops the rest; changing the key would
 * make every `ctx.run` resolve `undefined`.
 *
 * The replay case matters for the same reason: `persistIdempotentResult` stores
 * the ENCODED form, so `respondFromIdempotencyCache` must NOT encode again.
 */

/** A shard whose handler returns whatever `value` is set to — the value under test. */
class ReturningShard extends ShardDO {
    public value: unknown = undefined;

    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(this.value);
    }
}

/** A class instance — the shape `encodeWire` refuses rather than silently flattening to `{}`. */
class Money {
    public constructor(public readonly cents: number) {}
}

/**
 * A shard whose mutation writes a real row and THEN commits its bookkeeping with
 * `value`, exactly as a generated mutation branch does. Both halves are inside
 * one `runInTransaction`, so a throw from the bookkeeping must take the row with
 * it.
 */
class WritingMutationShard extends ShardDO {
    public runs = 0;

    public value: unknown = undefined;

    public constructor(
        state: ShardDOState,
        env: unknown,
        private readonly database: ReturnType<typeof createSqliteExec>,
    ) {
        super(state, env);
    }

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.runs += 1;

            this.database.sql.exec(
                'INSERT INTO messages (id, _creationTime, "__doc__") VALUES (?, ?, ?)',
                `msg-${String(this.runs)}`,
                Date.now(),
                JSON.stringify({ authorId: "u1", channelId: "c1", text: `debit-${String(this.runs)}` }),
            );

            this.commitMutationBookkeeping(this.value);

            return this.value;
        });
    }
}

/** Like {@link ReturningShard}, but `messages:sendMutator` is a `"next"` custom mutator (the watermarked push path). */
class ReturningMutatorShard extends ReturningShard {
    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.commitMutationBookkeeping(this.value);

            return this.value;
        });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: classifies by `functionPath` alone, no instance state.
    protected override isCustomMutator(functionPath: string): boolean {
        return functionPath === "messages:sendMutator";
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

/**
 * Extends {@link makeState} with `storage.transaction` — workerd's atomic,
 * auto-rolling-back boundary, backed here by real SQLite `BEGIN`/`COMMIT`/
 * `ROLLBACK` on the same connection the handler writes through.
 *
 * Without it `ShardHost.transaction` falls through to a bare call (it has no
 * raw-SQL fallback, because workerd forbids `BEGIN` inside a DO), so nothing
 * rolls back and a rollback assertion would pass vacuously.
 */
const makeTransactionalState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    const base = makeState(database);

    return {
        ...base,
        storage: {
            ...base.storage,
            transaction: async <T>(closure: () => Promise<T>): Promise<T> => {
                database.sql.exec("BEGIN");

                try {
                    const value = await closure();

                    database.sql.exec("COMMIT");

                    return value;
                } catch (error: unknown) {
                    database.sql.exec("ROLLBACK");

                    throw error;
                }
            },
        },
    } as ShardDOState;
};

const rpc = (functionPath: string, headers: Record<string, string> = {}): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

/** Dispatch one call on a fresh shard and hand back the parsed response envelope. */
const dispatchEnvelope = async (value: unknown): Promise<Record<string, unknown>> => {
    const database = createSqliteExec();

    try {
        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const shard = new ReturningShard(makeState(database), {});
        shard.value = value;

        const response = await shard.fetch(rpc("messages:list"));

        return await response.json();
    } finally {
        database.close();
    }
};

describe("shardDO dispatch result wire", () => {
    it("encodes a bigint result exactly once, inside a `{ result }` envelope", async () => {
        expect.assertions(2);

        const value = { amountCents: 4_294_967_296n };
        const envelope = await dispatchEnvelope(value);

        expect(envelope).toStrictEqual({ result: encodeWire(value) });
        // Spelled out, so a codec change cannot silently redefine what the
        // runner's single decode is fed.
        expect(envelope["result"]).toStrictEqual({ amountCents: ["$lunora.wire$", "bigint", "4294967296"] });
    });

    it("encodes a Date result exactly once", async () => {
        expect.assertions(2);

        const value = { dueAt: new Date("2026-06-01T12:00:00.000Z") };
        const envelope = await dispatchEnvelope(value);

        expect(envelope).toStrictEqual({ result: encodeWire(value) });
        expect(envelope["result"]).toStrictEqual({ dueAt: ["$lunora.wire$", "date", Date.parse("2026-06-01T12:00:00.000Z")] });
    });

    it("leaves a pure-JSON result structurally identical inside the envelope", async () => {
        expect.assertions(1);

        const value = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null }, note: "hi" };

        await expect(dispatchEnvelope(value)).resolves.toStrictEqual({ result: value });
    });

    it("tags a void handler's `undefined` rather than dropping the `result` key", async () => {
        expect.assertions(1);

        // `encodeWire` maps a top-level `undefined` to the tagged form, so the
        // key survives `JSON.stringify` — the runner's decode turns it back into
        // a real `undefined`.
        await expect(dispatchEnvelope(undefined)).resolves.toStrictEqual({ result: ["$lunora.wire$", "undefined"] });
    });

    it("encodes a custom-mutator push's result once, inside a `{ lastMutationId, result }` envelope", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new ReturningMutatorShard(makeState(database), {});
            shard.value = { balance: 9_007_199_254_740_993n };

            const response = await shard.fetch(rpc("messages:sendMutator", { "x-lunora-client-id": "c1", "x-lunora-client-seq": "1" }));

            await expect(response.json()).resolves.toStrictEqual({ lastMutationId: 1, result: encodeWire(shard.value) });
        } finally {
            database.close();
        }
    });

    it("returns the identical encoded envelope when a dedup replay hits the idempotency cache", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new ReturningShard(makeState(database), {});
            shard.value = { balance: 9_007_199_254_740_993n };

            // `x-lunora-mutation-id` with no client seq is exactly what the
            // dispatch runner sends (`RunFunctionOptions.dedupId`), so this is
            // the replay a re-fired `ctx.run` actually takes — NOT the
            // client-watermark ack, which answers `result: null` and is
            // unreachable without an `x-lunora-client-seq`.
            // `commitCursor` rides along because the mutation-id header puts
            // this on the mutation path of a CDC-enabled shard — the third
            // envelope variant, and the one a re-fired `ctx.run` actually sees.
            const replay = { "x-lunora-mutation-id": "m1" };
            const expected = { commitCursor: 0, result: encodeWire(shard.value) };
            const fresh = await shard.fetch(rpc("payments:charge", replay));

            await expect(fresh.json()).resolves.toStrictEqual(expected);

            // The cache stores the ENCODED form, so the cached branch must not
            // encode again — a second pass would leave the runner's single
            // decode a still-tagged value, and a `Date` a `{}`.
            const cached = await shard.fetch(rpc("payments:charge", replay));

            await expect(cached.json()).resolves.toStrictEqual(expected);
        } finally {
            database.close();
        }
    });

    it("rolls a mutation back when its return value cannot be wire-encoded, and names the value", async () => {
        expect.assertions(6);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new WritingMutationShard(makeTransactionalState(database), {}, database);

            shard.value = new Money(500);

            const rows = (): number => (database.sql.exec("SELECT COUNT(*) AS n FROM messages").one() as { n: number }).n;
            const dedupRows = (): number => (database.sql.exec("SELECT COUNT(*) AS n FROM __idempotency").one() as { n: number }).n;

            const headers = { "x-lunora-mutation-id": "m1", "x-lunora-userid": "u1" };
            const first = await shard.fetch(rpc("payments:charge", headers));

            // The encode runs INSIDE the handler's transaction, so the row the
            // handler wrote went back with it. Previously the write committed,
            // the dedup row was swallowed by the bookkeeping's best-effort catch,
            // and the response then failed on a second encode — an effect that
            // stood behind a non-transient 500 with no replay guard.
            expect(rows()).toBe(0);
            expect(dedupRows()).toBe(0);

            // The codec's refusal is surfaced with its own code and message —
            // not the redacted `RPC_FAILED` an unrecognized throw would become,
            // which named nothing and left the developer with a bare 500.
            expect(first.status).toBe(500);
            await expect(first.json()).resolves.toMatchObject({
                error: { code: "WIRE_ENCODE_FAILED", message: expect.stringContaining("Money") as unknown as string },
            });

            // And so the client's retry is safe: it re-runs the handler and,
            // once the handler returns something encodable, applies exactly one
            // write rather than a second one on top of a committed first.
            shard.value = { cents: 500 };

            const retry = await shard.fetch(rpc("payments:charge", headers));

            expect(retry.status).toBe(200);
            expect(rows()).toBe(1);
        } finally {
            database.close();
        }
    });
});
