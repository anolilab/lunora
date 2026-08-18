import { AsyncLocalStorage } from "node:async_hooks";

import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * End-to-end mutation-replay dedup over the real dispatch path (`fetch` → read
 * short-circuit → `handleRpc`/`runInTransaction` → in-transaction write),
 * driven through a real SQLite engine. The ctx-db helper tests prove the
 * `__idempotency` round-trip in isolation; this proves the shard wires the
 * read and the write to the SAME source — the `x-lunora-mutation-id` header,
 * stashed into `currentRequestMutationId` — so a replay actually short-circuits
 * instead of re-running the handler.
 */

/* eslint-disable no-secrets/no-secrets -- doc comment names framework classes/methods, not credentials */

/**
 * A shard whose handler bumps a counter INSIDE a transaction, so a second
 * execution is observable in `runs`. The dedup must serve the first call's
 * cached `{ runs: 1 }` on a replay without ever reaching this body again.
 *
 * Calls `commitMutationBookkeeping` inside its own `runInTransaction`, exactly
 * as generated `handleRpc` mutation branches do (`packages/codegen/src/emit.ts`,
 * the `registered.kind === "mutation"` branch) — the idempotency row commits
 * atomically with the writes, before `handleRpc` returns. The non-concurrent
 * tests below don't depend on this timing (they `await` one dispatch at a
 * time), but the concurrent-dispatch tests do: they exist to prove the row is
 * durable by the time a second dispatch's read can observe it, which only
 * holds if the write happens on the production code path, not the
 * `recordPostDispatchBookkeeping` post-`handleRpc` fallback that exists for
 * actions/queries.
 */
class CountingMutationShard extends ShardDO {
    public runs = 0;

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.runs += 1;

            const result = { runs: this.runs };

            this.commitMutationBookkeeping(result);

            return result;
        });
    }
}

/**
 * A shard that reports function kinds the way the generated subclass does
 * (`messages:send` is the only mutation) and whose ACTION handler parks until
 * released — standing in for the outbound I/O a real action awaits.
 */
class ParkingActionShard extends ShardDO {
    public readonly started: string[] = [];

    public runs = 0;

    /** Set by the test: the action handler awaits it before returning. */
    public parked: Promise<void> | undefined;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.started.push(functionPath);
        this.runs += 1;

        if (functionPath === "messages:slowAction" && this.parked !== undefined) {
            await this.parked;
        }

        return { ran: functionPath };
    }

    // eslint-disable-next-line class-methods-use-this -- pure predicate over the path, mirroring the codegen override
    protected override isMutationFunction(functionPath: string): boolean {
        return functionPath === "messages:send";
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
 * `blockConcurrencyWhile` double that ACTUALLY serializes — a FIFO queue, not
 * the bare passthrough `ShardHost.runSerialized` falls back to when the state
 * omits the hook entirely (see `createShardHost` in
 * `@lunora/platform-cloudflare`). The concurrent-dispatch tests below need the
 * real thing: without it, two `Promise.all`-driven `fetch()` calls interleave
 * identically whether or not the widened serialized span from Step 1 is
 * applied, and the race assertion would pass unconditionally either way.
 *
 * Workerd's real gate does NOT queue "events that were not explicitly
 * initiated as part of the callback itself" behind the callback — i.e. a
 * nested `blockConcurrencyWhile` call made from code the running callback
 * itself calls (`handleRpc` → `runInTransaction` → `ShardHost.runSerialized`
 * again) runs in place rather than deadlocking on the still-held outer gate.
 * A bare FIFO mutex double gets this wrong — it can't distinguish "nested
 * call on the same causal chain" from "a second, unrelated top-level
 * dispatch" and deadlocks on the former. `AsyncLocalStorage` tracks exactly
 * that distinction: its store follows one call's own await chain (including
 * through `Promise.all`-driven concurrent branches) without leaking into a
 * sibling branch, so only a genuinely nested call bypasses the queue.
 */
const makeSerializedState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    let queue: Promise<void> = Promise.resolve();
    const insideGate = new AsyncLocalStorage<true>();

    return {
        ...makeState(database),
        blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => {
            if (insideGate.getStore() === true) {
                return callback();
            }

            const previous = queue;
            let release: () => void = () => {};

            queue = new Promise<void>((resolve) => {
                release = resolve;
            });

            await previous;

            try {
                return await insideGate.run(true, callback);
            } finally {
                release();
            }
        },
    };
};

const mutationRequest = (mutationId?: string, userId?: string, clientId?: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
        headers: {
            "content-type": "application/json",
            ...(clientId === undefined ? {} : { "x-lunora-client-id": clientId }),
            ...(mutationId === undefined ? {} : { "x-lunora-mutation-id": mutationId }),
            ...(userId === undefined ? {} : { "x-lunora-userid": userId }),
        },
        method: "POST",
    });

const rpcRequest = (functionPath: string, mutationId: string, userId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-lunora-mutation-id": mutationId,
            "x-lunora-userid": userId,
        },
        method: "POST",
    });

describe("shardDO mutation-replay dedup (dispatch path)", () => {
    it("does NOT hold the single-writer gate for an action carrying a mutation-id header", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeSerializedState(database), {});

            let release: () => void = () => {};

            shard.parked = new Promise<void>((resolve) => {
                release = resolve;
            });

            // `x-lunora-mutation-id` is caller-supplied and the runtime forwards
            // it verbatim for EVERY function kind. Gating on its presence alone
            // put an action's whole body — an LLM call, a payment round-trip —
            // inside `blockConcurrencyWhile`, so any caller could freeze every
            // query, mutation, socket frame and alarm on the shard for that long,
            // repeatedly, with a fresh id each time.
            const slowAction = shard.fetch(rpcRequest("messages:slowAction", "m-1", "u1"));

            // Let the action reach its park before the sibling is dispatched.
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(shard.started).toStrictEqual(["messages:slowAction"]);

            const sibling = shard.fetch(rpcRequest("messages:otherAction", "m-2", "u1"));

            const outcome = await Promise.race([
                sibling.then(() => "sibling-served"),
                new Promise((resolve) => {
                    setTimeout(resolve, 50, "blocked-behind-action");
                }),
            ]);

            expect(outcome).toBe("sibling-served");

            release();

            const slowResponse = await slowAction;

            await expect(slowResponse.json()).resolves.toEqual({ result: { ran: "messages:slowAction" } });
        } finally {
            database.close();
        }
    });

    it("records an action's dedup row under ITS OWN identity when a sibling dispatch interleaves", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            let release: () => void = () => {};

            shard.parked = new Promise<void>((resolve) => {
                release = resolve;
            });

            // u1's action parks mid-handler. u2's dispatch then runs its whole
            // prologue, overwriting the shared `currentRequest*` fields. When u1
            // resumes, its post-dispatch bookkeeping reads those fields off
            // `this` — so without a re-pin it files u1's dedup row under u2.
            const slow = shard.fetch(rpcRequest("messages:slowAction", "m-1", "u1"));

            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            await shard.fetch(rpcRequest("messages:otherAction", "m-2", "u2"));

            release();
            await slow;

            expect(shard.runs).toBe(2);

            // u1 replays its own id. It only short-circuits if the row was
            // written under u1's namespace.
            await shard.fetch(rpcRequest("messages:slowAction", "m-1", "u1"));

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("runs a mutation once and serves the cached result on replay of the same id", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const first = await shard.fetch(mutationRequest("m-1", "u1"));

            await expect(first.json()).resolves.toEqual({ result: { runs: 1 } });

            const second = await shard.fetch(mutationRequest("m-1", "u1"));

            // The replay returns the FIRST result verbatim, not `{ runs: 2 }`,
            // because the handler never ran a second time.
            await expect(second.json()).resolves.toEqual({ result: { runs: 1 } });
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("re-executes every call when no mutation id is supplied (query / legacy client)", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            await shard.fetch(mutationRequest());
            await shard.fetch(mutationRequest());

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("treats distinct mutation ids as distinct writes", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const a = await shard.fetch(mutationRequest("m-1", "u1"));

            await expect(a.json()).resolves.toEqual({ result: { runs: 1 } });

            const b = await shard.fetch(mutationRequest("m-2", "u1"));

            await expect(b.json()).resolves.toEqual({ result: { runs: 2 } });
        } finally {
            database.close();
        }
    });

    it("namespaces by identity: the same id under a different user runs independently", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const u1 = await shard.fetch(mutationRequest("shared", "u1"));

            await expect(u1.json()).resolves.toEqual({ result: { runs: 1 } });

            // Same id, different user → a distinct dedup key → the handler runs.
            const u2 = await shard.fetch(mutationRequest("shared", "u2"));

            await expect(u2.json()).resolves.toEqual({ result: { runs: 2 } });

            // u1 replays its own id → cached, handler not re-run.
            const u1Replay = await shard.fetch(mutationRequest("shared", "u1"));

            await expect(u1Replay.json()).resolves.toEqual({ result: { runs: 1 } });
        } finally {
            database.close();
        }
    });

    it("namespaces ANONYMOUS callers by client id — one cannot suppress another's mutation", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            // An anonymous caller has no server-minted user id. Namespacing them all
            // under one key would let a colliding (reused / guessed) mutation id make
            // client B's write short-circuit to client A's cached result — suppressed
            // without ever running. The per-device client id keeps them apart.
            const a = await shard.fetch(mutationRequest("shared", undefined, "device-a"));

            await expect(a.json()).resolves.toEqual({ result: { runs: 1 } });

            const b = await shard.fetch(mutationRequest("shared", undefined, "device-b"));

            await expect(b.json()).resolves.toEqual({ result: { runs: 2 } });

            // Each still dedups its OWN replay.
            const aReplay = await shard.fetch(mutationRequest("shared", undefined, "device-a"));

            await expect(aReplay.json()).resolves.toEqual({ result: { runs: 1 } });
        } finally {
            database.close();
        }
    });

    it("skips the cache entirely for an anonymous caller with no client id (fails OPEN, never suppresses)", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            // No identity and no client id → no namespace that is safe to share, so
            // the handler re-runs (the pre-idempotency behaviour) rather than risk
            // serving — or suppressing — some other client's mutation.
            await shard.fetch(mutationRequest("shared"));
            await shard.fetch(mutationRequest("shared"));

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("runs the handler exactly once when the same mutation id is dispatched concurrently (Promise.all)", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeSerializedState(database), {});

            // An ordinary client retry of an unacked write: the same request,
            // in flight twice at once. Both must observe the SAME cache state —
            // one sees the miss and runs the handler, the other must not also
            // miss and re-run it (packages/do/src/shard-do.ts:4673-4715).
            const [first, second] = await Promise.all([shard.fetch(mutationRequest("m-1", "u1")), shard.fetch(mutationRequest("m-1", "u1"))]);

            expect(shard.runs).toBe(1);
            await expect(first.json()).resolves.toEqual({ result: { runs: 1 } });
            await expect(second.json()).resolves.toEqual({ result: { runs: 1 } });
        } finally {
            database.close();
        }
    });

    it("still runs both handlers when DIFFERENT mutation ids are dispatched concurrently (guards against over-serialization)", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeSerializedState(database), {});

            // The widened span in Step 1 is keyed on "has a mutation id", not on
            // its value — two DIFFERENT ids must not collide or dedupe against
            // each other, and dispatching them concurrently must not deadlock.
            const [a, b] = await Promise.all([shard.fetch(mutationRequest("m-1", "u1")), shard.fetch(mutationRequest("m-2", "u1"))]);
            const results = await Promise.all([a.json(), b.json()]);

            expect(shard.runs).toBe(2);
            expect(results).toContainEqual({ result: { runs: 1 } });
            expect(results).toContainEqual({ result: { runs: 2 } });
        } finally {
            database.close();
        }
    });
});
