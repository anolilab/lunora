/**
 * Real-workerd verification of the receiver-side in-flight dispatch claim (#803).
 *
 * `packages/do/__tests__/shard-do.dispatch-claim.test.ts` drives the same four
 * states against a hand-rolled state double. This file re-runs the load-bearing
 * ones inside actual `workerd`, against a real Durable Object with real SQLite
 * and the real `blockConcurrencyWhile` — because the property under test is
 * precisely that the UNGATED path takes no gate, and a double that models the
 * gate wrongly would prove nothing about which path production takes.
 *
 * What this file cannot model — and does not claim to — is an eviction:
 * `cloudflare:test` hands back the same instance, so "a fresh instance over the
 * same storage" (the stale-claim case) stays in the mock suite. That is the
 * right split, because the stale-claim answer here IS "the isolate is gone", and
 * an isolate workerd will not tear down is not one to assert against.
 *
 * Like every file in this directory, this suite only runs with
 * `LUNORA_WORKERD_TESTS=1` (see `packages/do/vitest.config.ts`).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestCounterDO } from "./test-worker";

const newStub = (name: string): DurableObjectStub<TestCounterDO> => env.COUNTER.get(env.COUNTER.idFromName(name));

/** The shape `dispatchToShard` sends for a scheduled action: the record id as the dedup id, under the `"system:"` namespace. */
const scheduled = (functionPath: string, recordId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", "x-lunora-mutation-id": recordId, "x-lunora-system": "1" },
        method: "POST",
    });

/** A plain, id-less dispatch — never claims, never declines. */
const plain = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", "x-lunora-system": "1" },
        method: "POST",
    });

const slowRuns = async (stub: DurableObjectStub<TestCounterDO>): Promise<number> => {
    const response = await stub.fetch(plain("counter:slowRuns"));
    const body = await response.json<{ result: { runs: number } }>();

    return body.result.runs;
};

describe("shardDO in-flight dispatch claim under real workerd", () => {
    it("declines a re-delivery whose handler is still running, and runs it exactly once", async () => {
        expect.assertions(4);

        const stub = newStub("claim-overlap");

        // The first attempt. Its dispatcher dies while this is parked, which is
        // what mints the second delivery below.
        const first = stub.fetch(scheduled("counter:slow", "job-1"));

        // Let it reach the park before the re-delivery lands. An id-less
        // dispatch is a real round-trip through the DO, so it is a sequencing
        // point rather than a timer guess.
        await expect(slowRuns(stub)).resolves.toBe(1);

        const second = await stub.fetch(scheduled("counter:slow", "job-1"));

        // COUNT, not presence, and asserted FIRST: without the claim the second
        // delivery has already entered the handler by now and this reads 2.
        await expect(slowRuns(stub)).resolves.toBe(1);
        expect(second.status).toBe(409);
        await expect(second.json()).resolves.toMatchObject({ error: { code: "DISPATCH_IN_PROGRESS" } });

        await stub.fetch(plain("counter:slowRelease"));
        await first;
    }, 10_000);

    it("serves the first attempt's cached result once it settles, so the decline is only ever temporary", async () => {
        expect.assertions(3);

        const stub = newStub("claim-settles");

        const first = stub.fetch(scheduled("counter:slow", "job-1"));

        await expect(slowRuns(stub)).resolves.toBe(1);

        await stub.fetch(plain("counter:slowRelease"));
        await first;

        // The scheduler's `recordRetry` re-fires the same record id after the
        // decline. The first attempt has settled, so the dedup row answers.
        const retry = await stub.fetch(scheduled("counter:slow", "job-1"));

        await expect(retry.json()).resolves.toEqual({ result: { run: 1 } });
        await expect(slowRuns(stub)).resolves.toBe(1);
    }, 10_000);

    it("does not decline a DIFFERENT id dispatched while one is in flight", async () => {
        expect.assertions(3);

        const stub = newStub("claim-distinct-ids");

        const first = stub.fetch(scheduled("counter:slow", "job-1"));

        await expect(slowRuns(stub)).resolves.toBe(1);

        const sibling = await stub.fetch(scheduled("counter:slow", "job-2"));

        expect(sibling.status).toBe(200);

        await stub.fetch(plain("counter:slowRelease"));
        await first;

        await expect(slowRuns(stub)).resolves.toBe(2);
    }, 10_000);

    it("leaves the MUTATION path untouched: a concurrent replay of the same id still runs the handler once", async () => {
        expect.assertions(2);

        const stub = newStub("claim-mutation-unchanged");

        const request = (): Request =>
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "counter:bump" }),
                headers: { "content-type": "application/json", "x-lunora-mutation-id": "m-1", "x-lunora-userid": "u1" },
                method: "POST",
            });

        // A mutation's dedup read and handler share one `runSerialized` span, so
        // the second dispatch waits and then finds the COMMITTED row — it must
        // be served that result, never a 409.
        const [first, second] = await Promise.all([stub.fetch(request()), stub.fetch(request())]);

        await expect(first.json()).resolves.toEqual({ result: { runs: 1 } });
        await expect(second.json()).resolves.toEqual({ result: { runs: 1 } });
    }, 10_000);
});
