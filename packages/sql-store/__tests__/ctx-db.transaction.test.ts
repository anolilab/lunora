import { DatabaseSync } from "node:sqlite";

import type { ConflictError, SchemaLike, SearchIndexDefinitionLike, ValidatorLike } from "@lunora/shard-engine";
import { aggregateTableName, rankTableName } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { takePostCommitError } from "../src/post-commit-error";
import type { QueryTimer } from "../src/query-timeout";
import { SqlQueryTimeoutError } from "../src/query-timeout";
import { companionFor } from "../src/search-layout";
import { createSqliteBatchHarness, makeSqliteDialect } from "./_helpers/sqlite";

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema = {
    tables: {
        tallies: {
            aggregateIndexes: [{ by: ["org"], name: "countByOrg", on: "tallies", op: "count" }],
            indexes: [],
            shape: { org: col("string") },
            shardMode: { kind: "global" },
        },
    },
} as unknown as SchemaLike;

const COUNTER = aggregateTableName("tallies", "countByOrg");

/** A `node:sqlite` exec with `transaction`, as the Postgres and MySQL-pool execs have; `seen` records every statement. */
const transactionalHarness = (
    failOn = `INSERT INTO "${COUNTER}"`,
): {
    close: () => void;
    exec: SqlCtxExec;
    failCompanion: (on: boolean) => void;
    seen: { params: ReadonlyArray<unknown>; sql: string }[];
    transactions: () => number;
} => {
    const database = new DatabaseSync(":memory:");
    const seen: { params: ReadonlyArray<unknown>; sql: string }[] = [];
    let failing = false;
    let transactions = 0;
    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => {
        seen.push({ params: parameters, sql: query });

        if (failing && query.startsWith(failOn)) {
            throw new Error("injected companion failure");
        }

        return database.prepare(query).all(...(parameters as never[]));
    };
    const plain: SqlCtxExec = {
        all: async (query, parameters) => all(query, parameters),
        run: async (query, parameters) => {
            all(query, parameters);
        },
    };

    return {
        close: () => {
            database.close();
        },
        exec: {
            ...plain,
            transaction: async (work) => {
                transactions += 1;
                database.exec("BEGIN");

                try {
                    const result = await work(plain);

                    database.exec("COMMIT");

                    return result;
                } catch (error) {
                    database.exec("ROLLBACK");
                    throw error;
                }
            },
        },
        failCompanion: (on) => {
            failing = on;
        },
        seen,
        transactions: () => transactions,
    };
};

describe("createSqlCtxDb — writes inside a transaction", () => {
    let harness: ReturnType<typeof transactionalHarness>;

    beforeEach(() => {
        harness = transactionalHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps the settled counter after a companion failure the transaction rolled back", async () => {
        expect.assertions(3);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema });

        await writer.insert("tallies", { org: "a" });
        harness.failCompanion(true);

        await expect(writer.insert("tallies", { org: "a" })).rejects.toThrow("injected companion failure");

        harness.failCompanion(false);
        harness.seen.length = 0;
        await writer.insert("tallies", { org: "a" });

        // The rollback left row and counter in step, so no rebuild re-scans the table.
        expect(harness.seen.some((statement) => statement.sql.includes("sqlite_master"))).toBe(false);
        await expect(writer.count("tallies", { org: "a" })).resolves.toBe(2);
    });

    it("marks a companion failure as after the row committed only when no transaction rolled the row back", async () => {
        expect.assertions(2);

        const dialect = makeSqliteDialect();
        const inTransaction = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });

        await inTransaction.insert("tallies", { _id: "seed", org: "a" }, { allowExplicitId: true });
        harness.failCompanion(true);

        const rolledBack = await inTransaction.insert("tallies", { _id: "t1", org: "a" }, { allowExplicitId: true }).catch((error: unknown) => error);

        // The row rolled back with its companions: a replayed import may retry it, so it is not vouched for.
        expect(takePostCommitError(rolledBack, "tallies", "t1")).toBe(false);

        const plain = transactionalHarness();

        try {
            const withoutTransaction: SqlCtxExec = { all: plain.exec.all, run: plain.exec.run };
            const alone = createSqlCtxDb({ clock: () => 1, dialect, exec: withoutTransaction, schema });

            await alone.insert("tallies", { _id: "seed", org: "a" }, { allowExplicitId: true });
            plain.failCompanion(true);

            const stored = await alone.insert("tallies", { _id: "t2", org: "a" }, { allowExplicitId: true }).catch((error: unknown) => error);

            // Without a transaction the row committed first and its companion then failed.
            expect(takePostCommitError(stored, "tallies", "t2")).toBe(true);
        } finally {
            plain.close();
        }
    });

    it("steps the two groups of a moving row in key order, whichever way it moves", async () => {
        expect.assertions(1);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema });
        const id = await writer.insert("tallies", { org: "b" });

        harness.seen.length = 0;
        await writer.patch("tallies", id, { org: "a" });

        // Opposite moves (a→b, b→a) then take the two group rows' locks in the same order and cannot deadlock.
        const keys = harness.seen.filter((statement) => statement.sql.startsWith(`INSERT INTO "${COUNTER}"`)).map((statement) => String(statement.params[0]));

        expect(keys).toStrictEqual(keys.toSorted((left, right) => (left < right ? -1 : Number(left > right))));
    });

    it.each([
        ["postgres deadlock", { code: "40P01" }],
        ["postgres serialization failure", { code: "40001" }],
        ["mysql deadlock", { code: "ER_LOCK_DEADLOCK", errno: 1213 }],
    ])("surfaces a %s as a retryable occ conflict", async (_label, fields) => {
        expect.assertions(1);

        const exec: SqlCtxExec = {
            ...harness.exec,
            transaction: async () => {
                throw Object.assign(new Error("lock cycle"), fields);
            },
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, schema });

        await expect(writer.insert("tallies", { org: "a" })).rejects.toMatchObject({ code: "CONFLICT", kind: "occ" } satisfies Partial<ConflictError>);
    });
});

describe("createSqlCtxDb — search provisioning keeps the statement deadline", () => {
    it("bounds the backfill page the search migration indexes", async () => {
        expect.assertions(1);

        const index: SearchIndexDefinitionLike = { field: "body", name: "by_body" };
        const searched = {
            tables: { notes: { indexes: [], searchIndexes: [index], shape: { body: col("string") }, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const companion = companionFor("notes", index);
        const harness = transactionalHarness();
        const armed = new Set<number>();
        let next = 0;
        const timer: QueryTimer = () => {
            const handle = next;

            next += 1;
            armed.add(handle);

            return () => {
                armed.delete(handle);
            };
        };
        let armedDuringSearch = false;
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                if (query.includes(companion)) {
                    // The deadline is armed just after the statement is issued.
                    await Promise.resolve();
                    armedDuringSearch ||= armed.size > 0;
                }

                return await harness.exec.all(query, parameters);
            },
            run: async (query, parameters) => {
                if (query.includes(companion)) {
                    // The deadline is armed just after the statement is issued.
                    await Promise.resolve();
                    armedDuringSearch ||= armed.size > 0;
                }

                await harness.exec.run(query, parameters);
            },
        };

        try {
            // A row from before the index existed, so provisioning has a backfill page to index.
            const unindexed = { tables: { notes: { ...searched.tables["notes"], searchIndexes: [] } } } as unknown as SchemaLike;
            const id = await createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: unindexed }).insert("notes", {
                body: "hello",
            });
            const reader = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema: searched });

            await reader.get("notes", id);

            expect(armedDuringSearch).toBe(true);
        } finally {
            harness.close();
        }
    });
});

describe("createSqlCtxDb — writes that need no transaction", () => {
    it("writes a row with no companions without opening one", async () => {
        expect.assertions(1);

        const harness = transactionalHarness();
        const bare = { tables: { tallies: { ...schema.tables["tallies"], aggregateIndexes: [] } } } as unknown as SchemaLike;

        try {
            await createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: bare }).insert("tallies", { org: "a" });

            expect(harness.transactions()).toBe(0);
        } finally {
            harness.close();
        }
    });
});

describe("createSqlCtxDb — restore's rank re-add", () => {
    it("rebuilds the rank when the re-add fails after the restoring patch committed", async () => {
        expect.assertions(2);

        const ranked = {
            tables: {
                notes: {
                    indexes: [],
                    rankIndexes: [{ name: "byPriority", on: "notes", sortBy: [{ direction: "desc", field: "priority" }] }],
                    shape: { deletedAt: { _meta: { column: {} }, kind: "number", optional: true }, priority: col("number") },
                    shardMode: { kind: "global" },
                    softDeleteMode: { field: "deletedAt" },
                },
            },
        } as unknown as SchemaLike;
        const harness = transactionalHarness(`INSERT INTO "${rankTableName("notes", "byPriority")}"`);

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: ranked });
            const id = await writer.insert("notes", { priority: 1 });

            await writer.rankPage("notes", "byPriority", { take: 10 });
            await writer.delete("notes", id);
            harness.failCompanion(true);

            await expect(writer.restore?.("notes", id)).rejects.toThrow("injected companion failure");

            harness.failCompanion(false);

            // The row is live again; its rank entry comes back from a rebuild rather than staying missing.
            const page = await writer.rankPage("notes", "byPriority", { take: 10 });

            expect(page.page.map((row) => row._id)).toStrictEqual([id]);
        } finally {
            harness.close();
        }
    });
});

describe("createSqlCtxDb — a companion batch that outlives its deadline (no transaction)", () => {
    it("counts a row once when its timed-out batch commits after the caller gave up", async () => {
        expect.assertions(3);

        const harness = createSqliteBatchHarness();
        const armed = new Map<number, () => void>();
        let next = 0;
        const timer: QueryTimer = (fire) => {
            const handle = next;

            next += 1;
            armed.set(handle, fire);

            return () => {
                armed.delete(handle);
            };
        };
        let hang = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let landed: Promise<void> = Promise.resolve();
        const exec: SqlCtxExec = {
            ...harness.exec,
            batch: async (statements) => {
                if (hang && statements.some((statement) => statement.sql.includes(COUNTER))) {
                    hang = false;
                    reached();
                    landed = (async () => {
                        await late;
                        await harness.exec.batch?.(statements);
                    })();
                    await landed;

                    return;
                }

                await harness.exec.batch?.(statements);
            },
        };

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema });

            await writer.insert("tallies", { org: "a" });

            await expect(writer.count("tallies", { org: "a" })).resolves.toBe(1);

            hang = true;

            const write = writer.insert("tallies", { org: "a" });

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await expect(write).rejects.toBeInstanceOf(SqlQueryTimeoutError);

            // A read while the batch is still in flight must not rebuild the counter from the table, which already
            // holds the row: the batch's own +1 would then count it a second time.
            await writer.count("tallies", { org: "a" });
            land();
            await landed;

            await expect(writer.count("tallies", { org: "a" })).resolves.toBe(2);
        } finally {
            harness.close();
        }
    });
});

describe("createSqlCtxDb — min/max group moves inside a transaction", () => {
    it("writes the two groups of a moving row in key order", async () => {
        expect.assertions(1);

        const maxed = {
            tables: {
                tallies: {
                    aggregateIndexes: [{ by: ["org"], field: "n", name: "maxByOrg", on: "tallies", op: "max" }],
                    indexes: [],
                    shape: { n: col("number"), org: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        const table = aggregateTableName("tallies", "maxByOrg");
        const harness = transactionalHarness();

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: maxed });

            await writer.insert("tallies", { n: 1, org: "a" });

            const id = await writer.insert("tallies", { n: 2, org: "b" });

            harness.seen.length = 0;
            await writer.patch("tallies", id, { org: "a" });

            // b→a: the adds group "a" sorts first, so its upsert precedes the removes group's write.
            const write = harness.seen.find((statement) => /^(?:INSERT|UPDATE|DELETE)/u.test(statement.sql) && statement.sql.includes(`"${table}"`));

            expect(write?.sql.startsWith("INSERT")).toBe(true);
        } finally {
            harness.close();
        }
    });
});
