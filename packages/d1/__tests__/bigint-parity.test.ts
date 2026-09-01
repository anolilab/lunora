import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, SchemaLike, SqlCursor, SqlExec, ValidatorLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * The `v.bigint()` ordering gate.
 *
 * Neither engine can hold a full-range integer natively, so both store a text
 * form — and the obvious one, plain decimal, is exact for `=` and wrong for
 * everything else: `"9"` sorts after `"10"`, so a range filter, an `ORDER BY`, a
 * page cursor and `MIN`/`MAX` all returned the wrong rows. `where: { n: { gt: 9n } }`
 * came back EMPTY while `10n` and `100n` sat in the table — fail-closed and
 * silent, which is why five audit rounds walked past it.
 *
 * The shard plane fixed this with an order-preserving key (`sql-projection.ts`);
 * the `.global()` plane kept `value.toString()`. Every case below runs the
 * identical rows through both and asserts the two answers are equal — the only
 * thing that holds "same query, same rows, whichever plane stores them" — and
 * pins the expected order by hand so three engines cannot agree on one wrong
 * answer.
 *
 * The pre-existing cross-plane gate (`search-parity.test.ts`) compares string
 * search only, which is exactly the hole this fills.
 */

/** Values chosen so decimal-text order and numeric order disagree on every pair that matters. */
const AMOUNTS: { amount: bigint; id: string }[] = [
    { amount: 2n, id: "r2" },
    { amount: 9n, id: "r9" },
    { amount: 10n, id: "r10" },
    { amount: 100n, id: "r100" },
    { amount: -5n, id: "rneg5" },
    { amount: -200n, id: "rneg200" },
    // Past 2^53, where `Number()` would collapse neighbours onto one double.
    { amount: 9_007_199_254_740_993n, id: "rbig" },
];

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const shardSchema: SchemaLike = {
    tables: {
        ledger: {
            indexes: [{ fields: ["amount"], name: "by_amount" }],
            shape: { amount: { kind: "bigint" }, memo: { kind: "string" } },
        },
    },
};

const globalSchema: SchemaLike = {
    tables: {
        ledger: {
            indexes: [{ fields: ["amount"], name: "by_amount" }],
            shape: { amount: col("bigint"), memo: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

let shardHarness: DatabaseSync;
let globalHarness: ReturnType<typeof createD1Exec>;

/** The DO store's synchronous `SqlExec` over `node:sqlite` (restated, as `search-parity.test.ts` does). */
const shardExec = (database: DatabaseSync): SqlExec => {
    return {
        exec: <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]): SqlCursor<Row> => {
            const rows = database.prepare(query).all(...(parameters as never[])) as Row[];

            return {
                one() {
                    if (rows.length !== 1) {
                        throw new Error(`expected exactly one row, received ${String(rows.length)}`);
                    }

                    return rows[0]!;
                },
                [Symbol.iterator]() {
                    return rows[Symbol.iterator]();
                },
                toArray() {
                    return rows;
                },
            };
        },
    };
};

const clockFrom = (): (() => number) => {
    let now = 1_700_000_000_000;

    return () => {
        now += 1000;

        return now;
    };
};

/** Seed both planes with the identical rows on the identical clock. */
const seedBoth = async (): Promise<{ global: DatabaseWriterLike; shard: DatabaseWriterLike }> => {
    const sql = shardExec(shardHarness);

    runShardMigrations(sql, shardSchema);

    const shard = createShardContextDatabase({ clock: clockFrom(), schema: shardSchema, sql });
    // No ddl(): the global table is auto-provisioned from the schema.
    const global = createD1ContextDatabase({ clock: clockFrom(), exec: globalHarness.exec, schema: globalSchema });

    for (const row of AMOUNTS) {
        const document = { _id: row.id, amount: row.amount, memo: row.id };

        // eslint-disable-next-line no-await-in-loop -- deterministic creation times require sequential inserts
        await shard.insert("ledger", document, { allowExplicitId: true });
        // eslint-disable-next-line no-await-in-loop -- same, on the global twin
        await global.insert("ledger", document, { allowExplicitId: true });
    }

    return { global, shard };
};

const ids = (documents: ReadonlyArray<Record<string, unknown>>): unknown[] => documents.map((document_) => document_["_id"]);

/** Run `probe` on both planes, assert they agree, and hand back the shared answer. */
const agree = async <T>(planes: { global: DatabaseWriterLike; shard: DatabaseWriterLike }, probe: (writer: DatabaseWriterLike) => Promise<T>): Promise<T> => {
    const shard = await probe(planes.shard);
    const global = await probe(planes.global);

    expect(global).toStrictEqual(shard);

    return shard;
};

describe("v.bigint() ordering parity — sharded DO vs .global()", () => {
    beforeEach(() => {
        shardHarness = new DatabaseSync(":memory:");
        globalHarness = createD1Exec();
    });

    afterEach(() => {
        shardHarness.close();
        globalHarness.close();
    });

    it("orders by a bigint column numerically, across zero and past 2^53", async () => {
        expect.assertions(4);

        const planes = await seedBoth();

        const ascending = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { orderBy: [{ amount: "asc" }] });

            return ids(page.page);
        });

        expect(ascending).toStrictEqual(["rneg200", "rneg5", "r2", "r9", "r10", "r100", "rbig"]);

        const descending = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { orderBy: [{ amount: "desc" }] });

            return ids(page.page);
        });

        expect(descending).toStrictEqual(["rbig", "r100", "r10", "r9", "r2", "rneg5", "rneg200"]);
    });

    it("answers a range filter over a bigint column with the rows a number comparison would", async () => {
        expect.assertions(6);

        const planes = await seedBoth();

        // The headline symptom: this returned NOTHING on the global plane while
        // 10n, 100n and 9007199254740993n sat in the table.
        const above = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { orderBy: [{ amount: "asc" }], where: { amount: { gt: 9n } } });

            return ids(page.page);
        });

        expect(above).toStrictEqual(["r10", "r100", "rbig"]);

        const below = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { orderBy: [{ amount: "asc" }], where: { amount: { lt: 0n } } });

            return ids(page.page);
        });

        expect(below).toStrictEqual(["rneg200", "rneg5"]);

        const inclusive = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { orderBy: [{ amount: "asc" }], where: { amount: { gte: -5n, lte: 10n } } });

            return ids(page.page);
        });

        expect(inclusive).toStrictEqual(["rneg5", "r2", "r9", "r10"]);
    });

    it("keeps equality exact either side of 2^53", async () => {
        expect.assertions(2);

        const planes = await seedBoth();

        const exact = await agree(planes, async (writer) => {
            const page = await writer.findMany("ledger", { where: { amount: 9_007_199_254_740_993n } });

            return ids(page.page);
        });

        expect(exact).toStrictEqual(["rbig"]);
    });

    it("pages a bigint order through the keyset cursor without repeating or dropping a row", async () => {
        expect.assertions(2);

        const planes = await seedBoth();

        const walk = async (writer: DatabaseWriterLike): Promise<unknown[]> => {
            const seen: unknown[] = [];
            let cursor: string | undefined;

            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- a keyset walk is sequential by construction
                const page = await writer.findMany("ledger", { cursor, limit: 3, orderBy: [{ amount: "asc" }] });

                seen.push(...ids(page.page));

                if (page.continueCursor === null) {
                    return seen;
                }

                cursor = page.continueCursor;
            }
        };

        const walked = await agree(planes, walk);

        expect(walked).toStrictEqual(["rneg200", "rneg5", "r2", "r9", "r10", "r100", "rbig"]);
    });

    /**
     * The one thing the key costs. `"1000…0010"` is not a number any engine can
     * add up, so a SQL-side reduce must refuse rather than return the 1.5e40 that
     * falls out of coercing padded text — and, before the refusal existed on this
     * plane, `sum` past 2^53 escaped as a raw driver `RangeError`.
     */
    it("refuses a SQL-side reduce over a bigint column on both planes, naming the aggregateIndex", async () => {
        expect.assertions(4);

        const planes = await seedBoth();

        for (const writer of [planes.shard, planes.global]) {
            // eslint-disable-next-line no-await-in-loop -- two planes, one assertion each
            await expect(writer.aggregate("ledger", { field: "amount", op: "sum" })).rejects.toThrow(/order-preserving key.*aggregateIndex/su);
            // eslint-disable-next-line no-await-in-loop -- same
            await expect(writer.groupBy("ledger", { agg: { field: "amount", op: "max" }, by: ["memo"] })).rejects.toThrow(/order-preserving key/u);
        }
    });
});
