/**
 * Dotted paths into an object column on real workerd SQLite: `where: { "profile.plan": "pro" }` and
 * `patch(id, { "profile.plan": "team" })`.
 *
 * `json_extract` over a nested path, and what it returns for a missing intermediate object or a number
 * stored as text, are properties of workerd's SQLite build, which `node:sqlite` cannot answer.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const leaf = (kind: string): unknown => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema = {
    tables: {
        users: {
            indexes: [],
            shape: {
                name: leaf("string"),
                profile: {
                    _meta: {
                        column: { notNull: false },
                        shape: {
                            address: { _meta: { column: { notNull: true }, shape: { city: leaf("string") } }, kind: "object" },
                            age: leaf("number"),
                            plan: leaf("string"),
                        },
                    },
                    kind: "object",
                },
            },
        },
    },
} as unknown as SchemaLike;

describe("dotted paths on workerd", () => {
    it("filters by a nested path and updates one nested key", async () => {
        expect.assertions(6);

        const stub = env.SHARD.get(env.SHARD.idFromName("json-paths"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

            runShardMigrations(sql, schema);

            const db = createShardCtxDb({ schema, sql });
            const ids = async (where: Record<string, unknown>): Promise<string[]> => {
                const page = await db.findMany("users", { where });

                return page.page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));
            };

            await db.insert("users", { _id: "a", name: "a", profile: { address: { city: "Berlin" }, age: 30, plan: "pro" } }, { allowExplicitId: true });
            await db.insert("users", { _id: "b", name: "b", profile: { plan: "free" } }, { allowExplicitId: true });
            await db.insert("users", { _id: "c", name: "c", profile: { age: "30", plan: "pro" } }, { allowExplicitId: true });
            await db.insert("users", { _id: "d", name: "d" }, { allowExplicitId: true });

            await expect(ids({ "profile.plan": "pro" })).resolves.toStrictEqual(["a", "c"]);
            await expect(ids({ "profile.address.city": "Berlin" })).resolves.toStrictEqual(["a"]);
            // A missing intermediate object and a missing column both read as null.
            await expect(ids({ "profile.address.city": null })).resolves.toStrictEqual(["b", "c", "d"]);
            // 30 is not "30".
            await expect(ids({ "profile.age": 30 })).resolves.toStrictEqual(["a"]);

            await db.patch("b", { "profile.address.city": "Paris" });

            const patched = await db.get("b");

            expect(patched?.["profile"]).toStrictEqual({ address: { city: "Paris" }, plan: "free" });
            await expect(ids({ "profile.address.city": "Paris" })).resolves.toStrictEqual(["b"]);
        });
    });
});
