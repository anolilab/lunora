/**
 * Dotted paths into an object column on a `.global()` table, against a **real** D1 binding in workerd.
 *
 * The store reads into a JSON-text column with `json_extract`; whether D1 admits that over a nested path, and
 * how it compares the extracted value with a bound parameter, is a question for D1 itself. Each test owns a
 * table name: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

const d1Dialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    maxTableColumns: 100,
    name: "sqlite",
    supportsFts5: false,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

const leaf = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const d1Exec: SqlCtxExec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
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

        const patched = await writer.get("b");

        expect(patched?.["profile"]).toStrictEqual({ plan: "team" });
        await expect(ids({ "profile.plan": "team" })).resolves.toStrictEqual(["b"]);
    });
});
