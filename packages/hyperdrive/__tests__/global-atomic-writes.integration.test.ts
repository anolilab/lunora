import type { SchemaLike } from "@lunora/shard-engine";
import { aggregateTableName } from "@lunora/shard-engine";
import type { SqlExec } from "@lunora/sql-store";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import mysql from "mysql2/promise";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { v } from "../../values/src/v";
import { fromPostgresJs } from "../src/create-hyperdrive";
import { createHyperdriveGlobalCtxDb } from "../src/global";
import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import { buildMysqlExec, buildPgExec } from "../src/global-exec";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";
import type { PgliteWireHarness } from "./_helpers/pglite-wire";
import createPgliteWireHarness from "./_helpers/pglite-wire";

/**
 * A row write and its aggregate companion write commit together on every Hyperdrive driver that can hold a
 * transaction: a companion write that fails leaves neither the row nor the counter changed, so the two cannot drift.
 */
const schema = {
    tables: {
        tallies: {
            aggregateIndexes: [{ by: ["org"], name: "countByOrg", on: "tallies", op: "count" }],
            indexes: [],
            shape: { org: v.string() },
            shardMode: { kind: "global" },
        },
    },
} as unknown as SchemaLike;

const COMPANION = aggregateTableName("tallies", "countByOrg");

/** `exec`, failing every companion write once `armed()` says so, inside a transaction or out of one. */
const failingCompanionWrites = (exec: SqlExec, armed: () => boolean): SqlExec => {
    const trip = (statement: string): void => {
        if (armed() && /^\s*(?:INSERT|UPDATE)/u.test(statement) && statement.includes(COMPANION)) {
            throw new Error("injected companion failure");
        }
    };
    const { transaction } = exec;

    return {
        ...exec,
        all: async (statement, parameters) => {
            trip(statement);

            return await exec.all(statement, parameters);
        },
        run: async (statement, parameters) => {
            trip(statement);

            return await exec.run(statement, parameters);
        },
        ...(transaction === undefined
            ? {}
            : {
                  transaction: async <T>(work: (tx: SqlExec) => Promise<T>): Promise<T> =>
                      await transaction(async (tx) => await work(failingCompanionWrites(tx, armed))),
              }),
    };
};

/** The rows `query` counted, from its single `n` column. */
const countOf = async (query: Promise<Record<string, unknown>[]>): Promise<number> => {
    const [row] = await query;

    return Number(row?.["n"]);
};

const assertRowAndCounterMoveTogether = async (engine: "mysql" | "postgres", exec: SqlExec, rowCount: () => Promise<number>): Promise<void> => {
    await runSqlGlobalTableMigrations(exec, schema, engine === "postgres" ? postgresDialect : mysqlDialect);

    let armed = false;
    const writer = createHyperdriveGlobalCtxDb({ engine, exec: failingCompanionWrites(exec, () => armed), schema });

    await writer.insert("tallies", { org: "a" });
    armed = true;

    await expect(writer.insert("tallies", { org: "a" })).rejects.toThrow("injected companion failure");

    armed = false;

    // The failed insert's row rolled back with its counter step: the indexed count and the table agree.
    await expect(rowCount()).resolves.toBe(1);
    await expect(writer.count("tallies", { org: "a" })).resolves.toBe(1);
};

describe("hyperdrive global — row and companion writes commit together", () => {
    describe("postgres (pglite)", () => {
        let harness: PgliteHarness;

        beforeAll(async () => {
            harness = await createPgliteHarness();
        });

        afterAll(async () => {
            await harness?.close();
        });

        it("rolls the row back when its companion write fails", async () => {
            expect.assertions(3);

            await assertRowAndCounterMoveTogether("postgres", harness.exec, async () => await countOf(harness.query(`SELECT COUNT(*) AS n FROM "tallies"`)));
        });
    });

    describe("postgres.js over the wire", () => {
        let harness: PgliteWireHarness;
        let sql: postgres.Sql;

        beforeAll(async () => {
            harness = await createPgliteWireHarness();

            const { host, password, port, user } = harness.binding;

            sql = postgres({ database: "postgres", fetch_types: false, host, max: 2, password, port, user });
        }, 60_000);

        afterAll(async () => {
            await sql?.end();
            await harness?.close();
        });

        it("rolls the row back when its companion write fails", async () => {
            expect.assertions(3);

            await assertRowAndCounterMoveTogether(
                "postgres",
                buildPgExec(fromPostgresJs(sql)),
                async () => await countOf(harness.query(`SELECT COUNT(*) AS n FROM "tallies"`)),
            );
        });
    });

    describe("mysql2 pool", () => {
        let harness: MysqlHarness | undefined;
        let unavailable: string | undefined;
        let pool: mysql.Pool | undefined;

        beforeAll(async () => {
            const result = await tryCreateMysqlHarness();

            harness = result.harness;
            unavailable = result.unavailable;

            if (harness !== undefined) {
                pool = mysql.createPool({ ...harness.connection, connectionLimit: 2, flags: ["FOUND_ROWS"] });
            }
        }, 180_000);

        beforeEach((context) => {
            if (unavailable !== undefined) {
                context.skip(unavailable);
            }
        });

        afterAll(async () => {
            await pool?.end();
            await harness?.close();
        });

        it("rolls the row back when its companion write fails", async () => {
            expect.assertions(3);

            const { query } = harness as MysqlHarness;

            await assertRowAndCounterMoveTogether(
                "mysql",
                buildMysqlExec(pool as mysql.Pool),
                async () => await countOf(query("SELECT COUNT(*) AS n FROM `tallies`")),
            );
        });
    });
});
