/**
 * Dotted paths into an object column on a `.global()` table, against a **real** D1 binding in workerd.
 *
 * The store reads into a JSON-text column with `json_extract`; whether D1 admits that over a nested path, and
 * how it compares the extracted value with a bound parameter, is a question for D1 itself. Each test owns a
 * table name: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../../src/ctx-db";
import { d1Dialect, d1Exec } from "./_helpers/d1";

const leaf = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: {
                indexes: [],
                shape: {
                    name: leaf("string"),
                    profile: { _meta: { column: { notNull: false }, shape: { age: leaf("number"), plan: leaf("string") } }, kind: "object" },
                },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

describe("dotted paths on D1", () => {
    it("filters by a nested path and updates one nested key", async () => {
        expect.assertions(5);

        const table = "json_path_users";
        const writer = createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec: d1Exec, schema: schemaFor(table) });
        const ids = async (where: Record<string, unknown>): Promise<string[]> => {
            const page = await writer.findMany(table, { where });

            return page.page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));
        };

        await writer.insert(table, { _id: "a", name: "a", profile: { age: 30, plan: "pro" } }, { allowExplicitId: true });
        await writer.insert(table, { _id: "b", name: "b", profile: { plan: "free" } }, { allowExplicitId: true });
        await writer.insert(table, { _id: "c", name: "c", profile: { age: "30", plan: "pro" } }, { allowExplicitId: true });
        await writer.insert(table, { _id: "d", name: "d" }, { allowExplicitId: true });

        await expect(ids({ "profile.plan": "pro" })).resolves.toStrictEqual(["a", "c"]);
        // 30 is not "30".
        await expect(ids({ "profile.age": 30 })).resolves.toStrictEqual(["a"]);
        await expect(ids({ "profile.age": null })).resolves.toStrictEqual(["b", "d"]);

        await writer.patch("b", { "profile.plan": "team" });

        const patched = await writer.get(table, "b");

        expect(patched?.["profile"]).toStrictEqual({ plan: "team" });
        await expect(ids({ "profile.plan": "team" })).resolves.toStrictEqual(["b"]);
    });
});
