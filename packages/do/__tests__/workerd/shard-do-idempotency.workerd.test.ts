/**
 * Real-workerd verification of plan 335's idempotency-race fix.
 *
 * `packages/do/__tests__/shard-do.idempotency.test.ts` proves the same
 * property against a hand-rolled `blockConcurrencyWhile` double
 * (`AsyncLocalStorage`-aware, modeling workerd's documented "does not queue
 * events initiated as part of the callback itself" semantics). A double
 * encodes the very assumption it's meant to verify — if the model is wrong,
 * it passes and production deadlocks a shard. This file re-runs the same two
 * assertions against the REAL `state.blockConcurrencyWhile` inside actual
 * `workerd`, where `ShardDO.fetch`'s widened `ShardHost.runSerialized` span
 * nests a SECOND `blockConcurrencyWhile` call inside the first (via
 * `handleRpc` → `runInTransaction` → `ShardRunner.runInTransaction`).
 *
 * `TestCounterDO` (`../workerd/test-worker.ts`) is a shard whose handler
 * calls `commitMutationBookkeeping` INSIDE its own transaction — the shape
 * generated mutation `handleRpc` branches use — so the dedup row commits
 * atomically with the write, through the real gate, not the post-`handleRpc`
 * fallback.
 *
 * Like every file in this directory, this suite only runs with
 * `LUNORA_WORKERD_TESTS=1` (see `packages/do/vitest.config.ts`) — the default
 * `pnpm --filter "@lunora/do" run test` does NOT execute it, only the `mocks`
 * project. Run explicitly: `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/do" run test`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestCounterDO } from "./test-worker";

const newStub = (name: string): DurableObjectStub<TestCounterDO> => {
    const id = env.COUNTER.idFromName(name);

    return env.COUNTER.get(id);
};

const mutationRequest = (mutationId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "counter:bump" }),
        headers: { "content-type": "application/json", "x-lunora-mutation-id": mutationId, "x-lunora-userid": "u1" },
        method: "POST",
    });

describe("shardDO mutation-replay dedup under real blockConcurrencyWhile (workerd)", () => {
    // Explicit timeout: a re-entrant-gate deadlock must surface as a FAILED
    // (timed-out) test, not an infinite run. This is the plan's flagged STOP
    // condition made observable — see plan 335 §"STOP conditions".
    it("runs the handler exactly once when the same mutation id is dispatched concurrently", async () => {
        expect.assertions(2);

        const stub = newStub("counter-same-id");

        const [first, second] = await Promise.all([stub.fetch(mutationRequest("m-1")), stub.fetch(mutationRequest("m-1"))]);
        const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

        // Both responses carry the SAME result — one dispatch ran the
        // handler, the other served the cached row. If the widened
        // `runSerialized` span deadlocked on its own nested call, this
        // test would time out instead of reaching this assertion.
        expect(firstBody).toEqual({ result: { runs: 1 } });
        expect(secondBody).toEqual({ result: { runs: 1 } });
    }, 5000);

    it("still runs both handlers when DIFFERENT mutation ids are dispatched concurrently (no over-serialization)", async () => {
        expect.assertions(2);

        const stub = newStub("counter-different-ids");

        const [first, second] = await Promise.all([stub.fetch(mutationRequest("m-1")), stub.fetch(mutationRequest("m-2"))]);
        const results = await Promise.all([first.json(), second.json()]);

        // Distinct ids must not collide or dedupe against each other —
        // both handler invocations actually ran, under the real gate.
        expect(results).toContainEqual({ result: { runs: 1 } });
        expect(results).toContainEqual({ result: { runs: 2 } });
    }, 5000);
});
