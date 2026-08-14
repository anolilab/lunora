import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetShardKvStore } from "../src/rivet-kv-store";

/**
 * The shared TCK covers read-back, idempotent delete and prefix exactness on a
 * well-behaved keyspace. These are the legs it does not reach: keys containing
 * SQL `LIKE` metacharacters, and values that `JSON.stringify` would quietly
 * mangle.
 */
describe("rivet shard kv store", () => {
    it("treats LIKE metacharacters in a prefix as literals", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const { kv } = createRivetShardKvStore(actor.db);

            await kv.put("s_a", 1);
            await kv.put("sxa", 2);
            await kv.put("s%b", 3);
            await kv.put("szb", 4);

            // Unescaped, `_` matches any single character and `%` matches
            // anything — so a prefix sweep would reach keys it was never
            // pointed at. Across tenants that is data loss, not an off-by-one.
            const underscore = await kv.list({ prefix: "s_" });
            const percent = await kv.list({ prefix: "s%" });

            expect([...underscore.keys()]).toStrictEqual(["s_a"]);
            expect([...percent.keys()]).toStrictEqual(["s%b"]);
        } finally {
            actor.cleanup();
        }
    });

    it("round-trips values JSON would flatten", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const { kv } = createRivetShardKvStore(actor.db);
            const when = new Date("2026-08-14T00:00:00.000Z");

            await kv.put("session", { roles: new Set(["admin"]), seen: when });

            const restored = await kv.get<{ roles: Set<string>; seen: Date }>("session");

            // `JSON.stringify` would turn the Date into a string with no way
            // back and drop the Set entirely; `ShardKvStore.put` promises
            // structured-clone fidelity.
            expect(restored?.seen).toBeInstanceOf(Date);
            expect(restored?.seen.toISOString()).toBe(when.toISOString());
            expect([...(restored?.roles ?? [])]).toStrictEqual(["admin"]);
        } finally {
            actor.cleanup();
        }
    });

    it("survives a wake, because it writes through to the actor's database", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const first = createRivetShardKvStore(actor.db);

            await first.kv.put("s:token-1", { userId: "ada" });

            // A second store over the same actor database is what the next wake
            // builds. Unlike the shard's SQL, this half needs no flush: it is
            // durable per write.
            const second = createRivetShardKvStore(actor.db);

            await expect(second.kv.get("s:token-1")).resolves.toStrictEqual({ userId: "ada" });
        } finally {
            actor.cleanup();
        }
    });
});
