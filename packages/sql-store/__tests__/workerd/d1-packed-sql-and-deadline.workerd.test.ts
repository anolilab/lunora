/**
 * The packed companion `UNION ALL` INSERTs and the statement deadline, against a **real** D1 binding in workerd.
 *
 * `node:sqlite` has no compound-select term limit and no bound-parameter cap, so a statement that D1 refuses
 * parses and runs there. These tests rebuild
 * companions with more rows than one INSERT may bind, and take the deadline path with an exec whose statements
 * D1 really applies late. Each test owns its table names: D1 storage is shared across the tests in this file.
 *
 * The deadline is the injected timer, fired by hand; every wait is on a milestone (a gate opened, a statement
 * observed landing), never on a clock.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { QueryTimer } from "../../src/query-timeout";
import { SqlQueryTimeoutError } from "../../src/query-timeout";
import { col, d1Dialect, d1Exec } from "./_helpers/d1";

const CLOCK = (): number => 1_700_000_000_000;

/** D1's own transactional `batch`: the statements run in order and a failure rolls all of them back. */
const d1BatchExec = (extra: { failBatch?: () => boolean } = {}): SqlCtxExec => {
    return {
        ...d1Exec,
        batch: async (statements) => {
            const prepared = statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params));

            // A statement that cannot run, appended, makes D1 roll the whole batch back.
            await env.DB.batch(extra.failBatch?.() === true ? [...prepared, env.DB.prepare('INSERT INTO "__no_such_table__" VALUES (1)')] : prepared);
        },
    };
};

const manualTimer = (): { fireAll: () => void; timer: QueryTimer } => {
    const armed = new Set<() => void>();

    return {
        fireAll: () => {
            for (const fire of armed) {
                fire();
            }
        },
        timer: (fire) => {
            armed.add(fire);

            return () => {
                armed.delete(fire);
            };
        },
    };
};

const rowsOf = async (table: string): Promise<number> => {
    const result = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();

    return Number(result?.n);
};

describe("packed companion INSERTs on D1", () => {
    it("rebuilds aggregate and rank companions that need several packed INSERTs", async () => {
        expect.assertions(4);

        const table = "packed_rebuild_scores";
        const withCompanions = {
            tables: {
                [table]: {
                    aggregateIndexes: [{ by: ["org"], name: "by_org", on: table, op: "count" }],
                    indexes: [],
                    rankIndexes: [{ name: "by_score", on: table, partitionBy: ["kind"], sortBy: [{ direction: "desc", field: "score" }] }],
                    shape: { kind: col("string"), org: col("string"), score: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        const bare = { tables: { [table]: { ...withCompanions.tables[table], aggregateIndexes: [], rankIndexes: [] } } } as unknown as SchemaLike;
        const seed = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec, schema: bare });
        let top = "";

        // 80 groups (one aggregate INSERT binds at most 32 rows) and 80 ranked rows (at most 32 per INSERT).
        for (let index = 0; index < 80; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding keeps the ids and scores deterministic.
            const id = await seed.insert(table, { kind: "k", org: `org${String(index)}`, score: index });

            if (index === 79) {
                top = id;
            }
        }

        // The seeded rows have no companions yet, so the first reads rebuild them from the table.
        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec, schema: withCompanions });

        await expect(writer.count(table, { org: "org0" })).resolves.toBe(1);
        await expect(writer.count(table, { org: "org79" })).resolves.toBe(1);
        await expect(writer.rank(table, "by_score", { row: top })).resolves.toStrictEqual({ position: 1, total: 80 });

        const counted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}__agg_by_org"`).first<{ n: number }>();

        expect(Number(counted?.n)).toBe(80);
    });
});

describe("the statement deadline and companion batches on D1", () => {
    const counted = (table: string): SchemaLike =>
        ({
            tables: {
                [table]: {
                    aggregateIndexes: [{ by: ["org"], name: "by_org", on: table, op: "count" }],
                    indexes: [],
                    shape: { org: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        }) as never;

    it("rebuilds the counters when a row write abandoned at its deadline lands after a rebuild", async () => {
        expect.assertions(4);

        const table = "deadline_late_row";
        const { fireAll, timer } = manualTimer();
        let hang = false;
        let reachedHang: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reachedHang = resolve;
        });
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let landed: Promise<unknown> = Promise.resolve();
        // D1 cannot cancel a statement: the INSERT is held, and applied by D1 only once released, after the caller was told it failed.
        const hold = <T>(query: string, send: () => Promise<T>): Promise<T> => {
            if (hang && query.startsWith(`INSERT INTO "${table}"`)) {
                hang = false;
                reachedHang();

                const late = gate.then(send);

                landed = late;

                return late;
            }

            return send();
        };
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await hold(query, async () => await d1Exec.all(query, parameters)),
            run: async (query, parameters) => await hold(query, async () => await d1Exec.run(query, parameters)),
        };
        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec, queryTimeoutMs: 5000, queryTimer: timer, schema: counted(table) });

        await writer.insert(table, { org: "a" });

        await expect(writer.count(table, { org: "a" })).resolves.toBe(1);

        hang = true;

        const write = writer.insert(table, { org: "a" });

        await hung;
        fireAll();

        await expect(write).rejects.toBeInstanceOf(SqlQueryTimeoutError);

        // Nothing has reached D1 for the abandoned write yet; a rebuild now tallies one row and is memoised.
        await expect(writer.count(table, { org: "a" })).resolves.toBe(1);

        release();
        await landed;

        // D1 applied the abandoned INSERT after that rebuild: the memo was dropped again, so the counter is rebuilt.
        await expect(writer.count(table, { org: "a" })).resolves.toBe(2);
    });

    it("leaves no partial companion rows when D1 rolls a companion batch back, and rebuilds them", async () => {
        expect.assertions(5);

        const table = "deadline_batch_rollback";
        let failNext = false;
        const exec = d1BatchExec({
            failBatch: () => {
                const fail = failNext;

                failNext = false;

                return fail;
            },
        });
        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec, schema: counted(table) });

        await writer.insert(table, { org: "a" });

        await expect(writer.count(table, { org: "a" })).resolves.toBe(1);

        failNext = true;

        // The row commits, then its companion batch is refused by D1: the batch is all-or-nothing, so the counter row is untouched.
        await expect(writer.insert(table, { org: "a" })).rejects.toThrow(/__no_such_table__|no such table/u);

        const stored = await env.DB.prepare(`SELECT SUM("__count__") AS n FROM "${table}__agg_by_org"`).first<{ n: number }>();

        await expect(rowsOf(table)).resolves.toBe(2);
        // The row is there but the rolled-back batch left the counter at one, not two and not a partial step.
        expect(Number(stored?.n)).toBe(1);

        // The failed batch evicted the rebuild memo, so the next read rebuilds the counter from the table.
        await expect(writer.count(table, { org: "a" })).resolves.toBe(2);
    });
});
