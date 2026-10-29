import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { v } from "../../values/src/v";
import { fromPostgresJs } from "../src/create-hyperdrive";
import { createPostgresGlobalCtxDb, postgresDialect } from "../src/global";
import { buildPgExec } from "../src/global-exec";
import { createPgVectorIndex } from "../src/pg-vector";
import type { PgliteWireHarness } from "./_helpers/pglite-wire";
import createPgliteWireHarness from "./_helpers/pglite-wire";

/**
 * Wide `in` / `notIn` lists through **postgres.js** over a real Postgres wire
 * connection, with `fetch_types: false` — the setting Hyperdrive recommends,
 * under which the driver knows no array types and sends a JS array bound to
 * `= ANY($1)` as a malformed array literal. The pglite suite beside this one
 * binds through pglite's own client, which infers arrays itself, so it cannot
 * see the difference.
 */
const WIDE = 70_000;

const schema = {
    tables: {
        wide: {
            indexes: [],
            shape: {
                big: v.bigint(),
                blob: v.bytes(),
                label: v.string(),
                n: v.number(),
                profile: { _meta: { column: { notNull: false }, shape: {} }, kind: "object" },
            },
            shardMode: { kind: "global" },
        },
    },
} as unknown as SchemaLike;

let harness: PgliteWireHarness;
let sql: postgres.Sql;
let writer: DatabaseWriterLike;

const labelsWhere = async (where: Record<string, unknown>): Promise<unknown[]> => {
    const result = await writer.findMany("wide", { where });

    return result.page.map((row) => String(row["label"])).toSorted((a, b) => a.localeCompare(b));
};

describe("hyperdrive global — postgres.js (fetch_types: false) over the wire", () => {
    beforeAll(async () => {
        harness = await createPgliteWireHarness();

        const { host, password, port, user } = harness.binding;

        sql = postgres({ database: "postgres", fetch_types: false, host, max: 1, password, port, user });

        const exec = buildPgExec(fromPostgresJs(sql as never));

        await runSqlGlobalTableMigrations(exec, schema, postgresDialect);
        writer = createPostgresGlobalCtxDb(fromPostgresJs(sql as never), { clock: () => 1_700_000_000_000, schema });

        await writer.insert("wide", { big: 7n, blob: new Uint8Array([1, 2]).buffer, label: "hit", n: 7, profile: { age: 30 } });
        await writer.insert("wide", { big: 8n, blob: new Uint8Array([3]).buffer, label: "miss", n: 8, profile: { age: "30" } });
    }, 60_000);

    afterAll(async () => {
        await sql?.end();
        await harness?.close();
    });

    it.each([
        ["text", "label", (index: number) => `decoy-${String(index)}`, "hit"],
        ["number", "n", (index: number) => 1000 + index, 7],
        ["bigint", "big", (index: number) => BigInt(1000 + index), 7n],
        ["bytes", "blob", (index: number) => new Uint8Array([200, index % 256, Math.floor(index / 256) % 256]).buffer, new Uint8Array([1, 2]).buffer],
    ] as const)(
        "matches a wide %s `in` / `notIn` list",
        async (_kind, field, decoy, wanted) => {
            expect.assertions(2);

            const list = [...Array.from({ length: WIDE }, (_, index) => decoy(index)), wanted];

            await expect(labelsWhere({ [field]: { in: list } })).resolves.toStrictEqual(["hit"]);
            await expect(labelsWhere({ [field]: { notIn: list } })).resolves.toStrictEqual(["miss"]);
        },
        60_000,
    );

    it("matches a dotted path through postgres.js by number and by text, and over a long list", async () => {
        expect.assertions(3);

        // `profile.age` is 30 on one row and "30" on the other: the JSON-bound value keeps the number and the text apart.
        await expect(labelsWhere({ "profile.age": 30 })).resolves.toStrictEqual(["hit"]);
        await expect(labelsWhere({ "profile.age": "30" })).resolves.toStrictEqual(["miss"]);

        const list = [...Array.from({ length: 40_000 }, (_, index) => index + 100), 30];

        await expect(labelsWhere({ "profile.age": { in: list } })).resolves.toStrictEqual(["hit"]);
    }, 60_000);

    it("still runs a parameter-free, multi-command statement", async () => {
        expect.assertions(1);

        // postgres.js sends a statement with no params over the simple protocol even with
        // `prepare: true`, and only that protocol accepts several commands in one string.
        await expect(
            fromPostgresJs(sql as never).query("CREATE TEMP TABLE multi (n int); INSERT INTO multi VALUES (1); DROP TABLE multi"),
        ).resolves.toBeDefined();
    });

    it("indexes and searches a search-indexed table through postgres.js", async () => {
        expect.assertions(1);

        const searchSchema = {
            tables: {
                notes: {
                    indexes: [],
                    searchIndexes: [{ field: "body", name: "by_body" }],
                    shape: { body: v.string() },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;

        await runSqlGlobalTableMigrations(buildPgExec(fromPostgresJs(sql as never)), searchSchema, postgresDialect);

        // The token rows go over as one JSON text param; a bare `::json` cast lets postgres.js
        // encode that string a second time, and `json_to_recordset` then rejects a scalar.
        const notes = createPostgresGlobalCtxDb(fromPostgresJs(sql as never), { clock: () => 1_700_000_000_000, schema: searchSchema });

        await notes.insert("notes", { body: "hello wire world" });

        const found = await notes
            .query("notes")
            .withSearchIndex("by_body", (q) => q.search("body", "wire"))
            .collect();

        expect(found.map((row) => row["body"])).toStrictEqual(["hello wire world"]);
    }, 60_000);

    it("reads, filters and deletes pgvector rows through postgres.js", async () => {
        expect.assertions(3);

        // Without fetched array types postgres.js sends `[["a,b", "c"]]` bound to
        // `ANY($1::text[])` as the literal `a,b,c`, which Postgres rejects.
        const store = createPgVectorIndex({ client: fromPostgresJs(sql as never), dimensions: 2, name: "wire" });

        await store.upsert([
            { id: "a,b", metadata: { kind: "x" }, values: [1, 0] },
            { id: "c", values: [0, 1] },
        ]);

        // A `jsonb` parameter postgres.js encoded twice would store the string `"{\"kind\":\"x\"}"`.
        const read = await store.getByIds(["a,b", "c"]);

        expect(read.toSorted((left, right) => left.id.localeCompare(right.id))).toMatchObject([{ id: "a,b", metadata: { kind: "x" } }, { id: "c" }]);
        await expect(store.query([1, 0], { filter: { kind: "x" }, topK: 5 })).resolves.toMatchObject({ matches: [{ id: "a,b" }] });
        await expect(store.deleteByIds(["a,b", "c"])).resolves.toMatchObject({ count: 2 });
    }, 60_000);
});
