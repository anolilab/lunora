import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { v } from "../../values/src/v";
import { fromPostgresJs } from "../src/create-hyperdrive";
import { createPostgresGlobalCtxDb, postgresDialect } from "../src/global";
import { buildPgExec } from "../src/global-exec";
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
            shape: { big: v.bigint(), blob: v.bytes(), label: v.string(), n: v.number() },
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

        await writer.insert("wide", { big: 7n, blob: new Uint8Array([1, 2]).buffer, label: "hit", n: 7 });
        await writer.insert("wide", { big: 8n, blob: new Uint8Array([3]).buffer, label: "miss", n: 8 });
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
});
