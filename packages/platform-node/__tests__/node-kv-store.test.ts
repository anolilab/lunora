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

    it("keeps a prefix case-sensitive, which SQLite LIKE is not", async () => {
        expect.assertions(3);

        const database = new Database(":memory:");

        try {
            const kv = createNodeShardKvStore(database);

            await kv.put("Alpha", 1);
            await kv.put("alpha", 2);
            await kv.put("ALPHA", 3);

            // SQLite's `LIKE` is case-insensitive for ASCII, so the statement
            // alone returns all three for any of these prefixes — the same
            // over-match escaping fixes for `_`/`%`, by a different route, and
            // with the same consequence for a prefix sweep.
            const upper = await kv.list({ prefix: "A" });
            const lower = await kv.list({ prefix: "a" });
            const shouting = await kv.list({ prefix: "ALP" });

            expect([...upper.keys()]).toStrictEqual(["ALPHA", "Alpha"]);
            expect([...lower.keys()]).toStrictEqual(["alpha"]);
            expect([...shouting.keys()]).toStrictEqual(["ALPHA"]);
        } finally {
            database.close();
        }
    });
});
