/**
 * Real-workerd verification that a dispatch re-pins its own caller CLAIMS after
 * a sibling has run.
 *
 * The interleave is the one a Durable Object actually serves: an action parked
 * on outbound I/O — no single-writer gate, so delivery of other events is not
 * blocked — while a second `/rpc` arrives, runs end to end, and both stamps and
 * then clears the shared `currentRequest*` fields. When the parked action
 * resumes it re-pins its own request scope before filing its durable
 * `__lunora_reqlog__` row; anything that scope does not carry is the sibling's
 * leftovers. The claims object is the one RLS grants roles from
 * (`readIdentityRoles`) and what `ctx.auth.getIdentity()` returns, so before it
 * joined the scope the row — and the Logpush/SIEM event built from it — named a
 * principal that never made the call.
 *
 * `packages/do/__tests__/shard-do.request-scope-identity.test.ts` pins the same
 * property against a hand-rolled `blockConcurrencyWhile` double. A double
 * encodes the very scheduling assumption under test — whether a sibling really
 * gets to run while another dispatch waits is decided by the runtime, not by us
 * — so this file re-runs it against real `workerd`, which also settles that the
 * interleave is reachable in production and not an artifact of the double.
 *
 * Like every file in this directory, this suite only runs with
 * `LUNORA_WORKERD_TESTS=1` (see `packages/do/vitest.config.ts`). Run explicitly:
 * `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/do" run test`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestCounterDO } from "./test-worker";

const PARKED = { claims: { role: "viewer", tenant: "zinc" }, userId: "userParked" };
const SIBLING = { claims: { role: "admin", tenant: "acme" }, userId: "userSibling" };

const rpcRequest = (functionPath: string, mutationId: string, caller: typeof PARKED): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-lunora-identity": JSON.stringify(caller.claims),
            "x-lunora-mutation-id": mutationId,
            "x-lunora-userid": caller.userId,
        },
        method: "POST",
    });

interface LoggedRow {
    functionPath: string;
    identity?: Record<string, unknown>;
    userId?: string;
}

describe("shardDO per-request scope under real workerd", () => {
    it("files a parked dispatch's request-log row under its own caller, claims included", async () => {
        expect.assertions(3);

        // A fresh shard and fresh mutation ids per run: Miniflare persists the
        // DO's SQLite between runs, and a replayed id is served from the
        // idempotency row — which would pass this test without dispatching.
        const run = crypto.randomUUID();
        const id = env.COUNTER.idFromName(`scope-parked-${run}`);
        const stub: DurableObjectStub<TestCounterDO> = env.COUNTER.get(id);

        const parked = stub.fetch(rpcRequest("counter:park", `m-park-${run}`, PARKED));

        // Delivered and served while `counter:park` is still in flight — which
        // is itself the property this file exists to settle. Its prologue
        // overwrites the shared caller fields and its epilogue then clears them.
        const sibling = await stub.fetch(rpcRequest("counter:release", `m-release-${run}`, SIBLING));

        await expect(sibling.json()).resolves.toEqual({ result: { released: true } });

        await parked;

        const logResponse = await stub.fetch(rpcRequest("counter:reqlog", `m-log-${run}`, SIBLING));
        const { result } = await logResponse.json<{ result: LoggedRow[] }>();
        const row = result.find((entry) => entry.functionPath === "counter:park");

        expect(row?.userId).toBe(PARKED.userId);
        expect(row?.identity).toEqual(PARKED.claims);
    }, 10_000);
});
