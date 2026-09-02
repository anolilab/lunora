import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { runSqlAggregateMigrations, runSqlGlobalTableMigrations, runSqlRankMigrations } from "@lunora/sql-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHyperdriveGlobalCtxDb } from "../src/global";
import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * String comparison has to mean the same thing on every `.global()` engine.
 *
 * SQLite compares TEXT byte for byte, and Postgres compares `text` for equality
 * byte for byte. MySQL 8's server default is `utf8mb4_0900_ai_ci` — accent- AND
 * case-insensitive — so an unqualified column inherited a third set of
 * semantics, and the divergence was not cosmetic: two tenants named `"Acme"` and
 * `"acme"` shared one `__agg_` counter row, `.unique()` rejected `alice@` against
 * `Alice@`, and a `rankPage` partitioned on the tenant key returned the OTHER
 * tenant's rows.
 *
 * Every case here runs the identical schema and the identical operations through
 * a real MySQL 8 and a real Postgres and asserts the two answers are equal. A
 * divergence is the bug, whichever side is "right".
 *
 * MySQL is provisioned by `mysql-memory-server`, which downloads mysqld on first
 * use. Where that download is blocked the MySQL half cannot run, so the suite
 * skips with the captured reason — see `_helpers/mysql-mem.ts`. That is a real
 * hole: no CI workflow provisions MySQL today, so this gate can pass by skipping.
 * The always-runs half of the same guarantee is the DDL assertion in
 * `global-dialect.test.ts`, which needs no server.
 */
const FIXED_CLOCK = 1_700_000_000_000;
const STARTUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 30_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const schema: SchemaLike = {
    tables: {
        accounts: {
            aggregateIndexes: [{ by: ["tenant"], field: "amount", name: "sumByTenant", on: "accounts", op: "sum" }],
            indexes: [],
            rankIndexes: [{ name: "byAmount", on: "accounts", partitionBy: ["tenant"], sortBy: [{ direction: "asc", field: "amount" }] }],
            shape: {
                amount: col("number"),
                email: col("string", { unique: true }),
                tenant: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
};

/** Two tenants that differ only in case, plus one row whose email differs only in case from another's. */
const ROWS = [
    { _id: "a1", amount: 10, email: "one@example.com", tenant: "Acme" },
    { _id: "a2", amount: 20, email: "two@example.com", tenant: "Acme" },
    { _id: "b1", amount: 100, email: "three@example.com", tenant: "acme" },
];

let mysql: MysqlHarness;
let mysqlUnavailable: string | undefined;
let pg: PgliteHarness;

/** Provision the schema on one engine and return its writer, freshly seeded. */
const seed = async (engine: "mysql" | "postgres"): Promise<DatabaseWriterLike> => {
    const exec = engine === "mysql" ? mysql.exec : pg.exec;
    const dialect = engine === "mysql" ? mysqlDialect : postgresDialect;

    await runSqlGlobalTableMigrations(exec, schema, dialect);
    await runSqlAggregateMigrations(exec, schema, dialect);
    await runSqlRankMigrations(exec, schema, dialect);

    const writer = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine, exec, schema });

    for (const row of ROWS) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order on a single shared connection
        await writer.insert("accounts", row, { allowExplicitId: true });
    }

    return writer;
};

interface Engines {
    mysql: DatabaseWriterLike;
    postgres: DatabaseWriterLike;
}

/** Provision + seed both engines once per test (a second seed would trip the `.unique()` index). */
const bothEngines = async (): Promise<Engines> => {
    return { mysql: await seed("mysql"), postgres: await seed("postgres") };
};

/** Run `probe` on both engines and assert they agree; returns the shared answer for a value assertion. */
const agree = async <T>(engines: Engines, probe: (writer: DatabaseWriterLike) => Promise<T>): Promise<T> => {
    const postgres = await probe(engines.postgres);
    const onMysql = await probe(engines.mysql);

    expect(onMysql).toStrictEqual(postgres);

    return postgres;
};

const ids = (docs: ReadonlyArray<Record<string, unknown>>): unknown[] => docs.map((document_) => document_["_id"]);

describe("global store — string comparison parity across MySQL and Postgres", () => {
    beforeAll(async () => {
        const result = await tryCreateMysqlHarness();

        if (result.harness) {
            mysql = result.harness;
        } else {
            mysqlUnavailable = result.unavailable;
        }
    }, STARTUP_TIMEOUT);

    // A fresh embedded Postgres per test needs no cleanup; the shared mysqld does.
    beforeEach(async (context) => {
        if (mysqlUnavailable !== undefined) {
            context.skip(mysqlUnavailable);
        }

        pg = await createPgliteHarness();

        for (const table of ["accounts", "__agg_accounts_sumByTenant", "__rank_accounts_byAmount"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential DDL on the one shared mysqld connection
            await mysql.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
    });

    afterEach(async () => {
        await pg?.close();
    });

    afterAll(async () => {
        await mysql?.close();
    });

    it(
        "counts and sums a case-distinct partition key as two groups, not one",
        async () => {
            expect.assertions(4);

            const engines = await bothEngines();
            const count = await agree(engines, async (writer) => writer.count("accounts", { tenant: "Acme" }));

            expect(count).toBe(2);

            const total = await agree(engines, async (writer) => writer.aggregate("accounts", { field: "amount", op: "sum", where: { tenant: "Acme" } }));

            expect(total).toBe(30);
        },
        TEST_TIMEOUT,
    );

    it(
        "keeps a rankPage inside its own partition — a case-distinct tenant is a different tenant",
        async () => {
            expect.assertions(2);

            const engines = await bothEngines();
            const page = await agree(engines, async (writer) => {
                const ranked = await writer.rankPage("accounts", "byAmount", { where: { tenant: "Acme" } });

                return ids(ranked.page);
            });

            expect(page).toStrictEqual(["a1", "a2"]);
        },
        TEST_TIMEOUT,
    );

    it(
        "matches eq / ne / unique by exact bytes, not by folded case",
        async () => {
            expect.assertions(6);

            const engines = await bothEngines();
            const shouting = await agree(engines, async (writer) => {
                const page = await writer.findMany("accounts", { where: { email: "ONE@EXAMPLE.COM" } });

                return ids(page.page);
            });

            expect(shouting).toStrictEqual([]);

            const notAcme = await agree(engines, async (writer) => {
                const page = await writer.findMany("accounts", { where: { tenant: { ne: "Acme" } } });

                return ids(page.page);
            });

            expect(notAcme).toStrictEqual(["b1"]);

            // `.unique()` on `email`: a case-distinct address is a different one,
            // so the insert must be ACCEPTED on both engines.
            const accepted = await agree(engines, async (writer) => {
                await writer.insert("accounts", { _id: "c1", amount: 1, email: "One@Example.com", tenant: "Acme" }, { allowExplicitId: true });

                const page = await writer.findMany("accounts", { where: { email: "One@Example.com" } });

                return ids(page.page);
            });

            expect(accepted).toStrictEqual(["c1"]);
        },
        TEST_TIMEOUT,
    );
});
