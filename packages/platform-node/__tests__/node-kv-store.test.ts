import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createNodeShardKvStore } from "../src/node-kv-store";

/**
 * The shared TCK covers prefix exactness on a well-behaved keyspace. This is
 * the leg it does not reach: keys containing SQL `LIKE` metacharacters, which
 * the prefix scan has to treat as literals.
 */
describe("node shard kv store", () => {
    it("treats LIKE metacharacters in a prefix as literals", async () => {
        expect.assertions(3);

        const database = new Database(":memory:");

        try {
            const kv = createNodeShardKvStore(database);

            await kv.put("s_a", 1);
            await kv.put("sxa", 2);
            await kv.put("s%b", 3);
            await kv.put("szb", 4);

            // Unescaped, `_` matches any single character and `%` matches
            // anything — so a prefix sweep would reach keys it was never
            // pointed at. Across tenants that is data loss, not an off-by-one.
            const underscore = await kv.list({ prefix: "s_" });
            const percent = await kv.list({ prefix: "s%" });
            const everything = await kv.list();

            expect([...underscore.keys()]).toStrictEqual(["s_a"]);
            expect([...percent.keys()]).toStrictEqual(["s%b"]);
            // And an absent prefix still enumerates everything, in key order.
            expect([...everything.keys()]).toStrictEqual(["s%b", "s_a", "sxa", "szb"]);
        } finally {
            database.close();
        }
    });
});
