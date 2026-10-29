import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHyperdriveGlobalCtxDb } from "../src/global";
import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * `orderBy: [{ score: { sort, nulls } }]` on a `.global()` table over a real Postgres and a real MySQL.
 *
 * Postgres is given the placement as an explicit `NULLS FIRST/LAST`; MySQL has no such clause, so a
 * non-default placement is emulated with a leading `(score IS NULL)` sort key. Both must agree with the
 * keyset seek, or paging a page boundary inside the NULL run skips or repeats rows. The paged result is
 * checked against an independent reference sort, so an ORDER BY and a seek that were wrong in the same way
 * would not pass.
 *
 * MySQL is provisioned by `mysql-memory-server`; where that download is blocked the MySQL half skips with the
 * captured reason, exactly as `global-collation-parity.test.ts` does.
 */
const STARTUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 30_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [],
            shape: { score: col("number", { notNull: false }) },
            shardMode: { kind: "global" },
        },
    },
};

/** Four NULLs and a tie on 3, so a page boundary lands inside the NULL run and inside a tie. */
const ROWS: [string, null | number][] = [
    ["a", null],
    ["b", 3],
    ["c", null],
    ["d", 1],
    ["e", null],
    ["f", 3],
    ["g", 2],
    ["h", null],
];

interface Combo {
    nulls: "first" | "last";
    sort: "asc" | "desc";
}

const COMBOS: Combo[] = [
    { nulls: "first", sort: "asc" },
    { nulls: "last", sort: "asc" },
    { nulls: "first", sort: "desc" },
    { nulls: "last", sort: "desc" },
];

/** The order a correct engine returns: by score with NULLs where asked, ties by id in the sort's direction. */
const expected = ({ nulls, sort }: Combo): string[] => {
    const sign = sort === "asc" ? 1 : -1;

    return ROWS.toSorted(([leftId, left], [rightId, right]) => {
        if (left !== right) {
            if (left === null) {
                return nulls === "first" ? -1 : 1;
            }

            if (right === null) {
                return nulls === "first" ? 1 : -1;
            }

            return (left - right) * sign;
        }

        return leftId.localeCompare(rightId) * sign;
    }).map(([id]) => id);
};

let mysql: MysqlHarness;
let mysqlUnavailable: string | undefined;
let pg: PgliteHarness;

const seed = async (engine: "mysql" | "postgres"): Promise<DatabaseWriterLike> => {
    const exec = engine === "mysql" ? mysql.exec : pg.exec;

    await runSqlGlobalTableMigrations(exec, schema, engine === "mysql" ? mysqlDialect : postgresDialect);

    const writer = createHyperdriveGlobalCtxDb({ clock: () => 1_700_000_000_000, engine, exec, schema });

    for (const [id, score] of ROWS) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order on a single shared connection
        await writer.insert("items", score === null ? { _id: id } : { _id: id, score }, { allowExplicitId: true });
    }

    return writer;
};

/** Page through the table three rows at a time and return every id in the order the pages came back. */
const pageAll = async (writer: DatabaseWriterLike, combo: Combo): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard < 10; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const page = await writer.findMany("items", { cursor, limit: 3, orderBy: [{ score: combo }] });

        seen.push(...page.page.map((row) => String(row["_id"])));

        if (page.isDone) {
            return seen;
        }

        cursor = page.continueCursor;
    }

    throw new Error("paging did not terminate");
};

describe.each([["postgres"], ["mysql"]] as const)("global store — orderBy null placement on %s", (engine) => {
    beforeAll(async () => {
        if (engine === "mysql") {
            const result = await tryCreateMysqlHarness();

            if (result.harness) {
                mysql = result.harness;
            } else {
                mysqlUnavailable = result.unavailable;
            }
        }
    }, STARTUP_TIMEOUT);

    beforeEach(async (context) => {
        if (engine === "mysql") {
            if (mysqlUnavailable !== undefined) {
                context.skip(mysqlUnavailable);
            }

            await mysql.query("DROP TABLE IF EXISTS `items`");
        } else {
            pg = await createPgliteHarness();
        }
    });

    afterEach(async () => {
        if (engine === "postgres") {
            await pg?.close();
        }
    });

    afterAll(async () => {
        await mysql?.close();
    });

    it.each(COMBOS)(
        "pages $sort with nulls $nulls in the reference order, with no row skipped or repeated",
        async (combo) => {
            expect.assertions(2);

            const writer = await seed(engine);
            const unpaged = await writer.findMany("items", { orderBy: [{ score: combo }] });

            expect(unpaged.page.map((row) => String(row["_id"]))).toStrictEqual(expected(combo));
            await expect(pageAll(writer, combo)).resolves.toStrictEqual(expected(combo));
        },
        TEST_TIMEOUT,
    );
});
