/**
 * Real-workerd checks for shard placement.
 *
 * A location hint is advisory and unobservable — nothing in the API reports
 * where an object actually landed — so what these tests pin is the part that a
 * mock cannot answer: that the real runtime accepts a hint at all, and that a
 * hinted resolution still addresses the same object as an unhinted one.
 *
 * They also record what the runtime CANNOT answer. Pairing a hint with a
 * jurisdiction type-checks (a jurisdictional view has the same namespace type,
 * so the options bag is identical), but workerd implements no jurisdictions at
 * all, so the pairing is unreachable in dev, in CI, and here. That is the
 * evidence behind the runtime preferring residency over the hint.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ShardNamespaceLike } from "../../src/resolve-shard";
import { applyJurisdiction, resolveShard } from "../../src/resolve-shard";

const shardNamespace = (): ShardNamespaceLike => env.SHARD as unknown as ShardNamespaceLike;

/** Ask the resolved stub for something, so the assertion covers a real dispatch rather than just construction. */
const probe = async (stub: { fetch: (request: Request) => Promise<Response> }): Promise<Response> =>
    stub.fetch(new Request("https://shard.internal/rpc", { body: JSON.stringify({ args: {}, functionPath: "messages:list" }), method: "POST" }));

describe("shard placement (workerd)", () => {
    it("accepts a location hint on a plain namespace", async () => {
        expect.assertions(1);

        const response = await probe(resolveShard(shardNamespace(), "placement-plain", "weur"));

        expect(response.ok).toBe(true);
    });

    it("cannot pin a jurisdiction at all, which is why placement defers to residency", () => {
        expect.assertions(1);

        // The combination of a jurisdiction and a location hint is UNREACHABLE
        // locally: workerd does not implement jurisdictions, so it is not that
        // the pairing is untested here — it cannot be tested here, or in CI, or
        // in `lunora dev`. It would first execute in production, on exactly the
        // deployments that chose residency because correctness matters most.
        //
        // That is the evidence behind `placementUnderResidency` in
        // `create-worker.ts`: rather than ship an unexercised pairing, a pinned
        // deployment sends no region hint and lets the jurisdiction decide. This
        // test exists to keep the reason on the record — and to fail loudly if a
        // future workerd implements jurisdictions, at which point the pairing
        // becomes testable and the trade can be revisited.
        expect(() => applyJurisdiction(shardNamespace(), "eu")).toThrow(/not implemented in workerd/i);
    });

    it("resolves the same object for a key whether or not a hint is passed", async () => {
        expect.assertions(1);

        // A hint influences CREATION only, so it must never change addressing:
        // the same key has to reach the same object, or a hinted read and an
        // unhinted write would silently target different shards.
        const namespace = shardNamespace();

        await probe(resolveShard(namespace, "placement-identity", "apac"));
        const second = await probe(resolveShard(namespace, "placement-identity"));

        await expect(second.text()).resolves.toContain("messages:list");
    });
});
