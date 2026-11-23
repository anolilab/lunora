import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import type { QueryTimer } from "../src/query-timeout";
import { SqlQueryTimeoutError } from "../src/query-timeout";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const text = { _meta: { column: { notNull: true } }, kind: "string" } as ValidatorLike;

/** A before-delete trigger on `posts` that records the deletion in `audit`, through the writer it is handed. */
const schema = {
    tables: {
        audit: { indexes: [], shape: { postId: text }, shardMode: { kind: "global" } },
        posts: {
            indexes: [],
            shape: { title: text },
            shardMode: { kind: "global" },
            triggerMap: {
                recordDeletion: {
                    handler: async (
                        context: { db: { insert: (table: string, document: Record<string, unknown>) => Promise<string> } },
                        event: { id: string },
                    ) => {
                        await context.db.insert("audit", { postId: event.id });
                    },
                    op: "delete",
                    timing: "before",
                },
            },
        },
    },
} as never as SchemaLike;

/** A query timer whose deadlines the test fires by hand. */
const recordingTimer = (): { deadlines: Set<() => void>; timer: QueryTimer } => {
    const deadlines = new Set<() => void>();
    const timer: QueryTimer = (fire) => {
        deadlines.add(fire);

        return () => {
            deadlines.delete(fire);
        };
    };

    return { deadlines, timer };
};

let harness: ReturnType<typeof createSqliteHarness>;

describe("createSqlCtxDb onWrite", () => {
    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("announces the table a trigger wrote through the writer, not only the table the caller wrote", async () => {
        expect.assertions(1);

        const written: string[] = [];
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            onWrite: (table) => {
                written.push(table);
            },
            schema,
        });
        const id = await writer.insert("posts", { title: "hello" });

        written.length = 0;
        await writer.delete("posts", id);

        expect(written).toStrictEqual(["audit", "posts"]);
    });

    it("announces nothing for a write that stored no row", async () => {
        expect.assertions(1);

        const written: string[] = [];
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            onWrite: (table) => {
                written.push(table);
            },
            schema,
        });

        await writer.delete("posts", "missing");

        expect(written).toStrictEqual([]);
    });
});

describe("createSqlCtxDb onWrite for a statement abandoned at its deadline", () => {
    let stored: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        stored = createSqliteHarness();
    });

    afterEach(() => {
        stored.close();
    });

    it.each([
        ["an exec without transactions", false],
        ["a transaction-capable exec writing a table with no companions", true],
    ])("announces the table once the statement settles, through %s", async (_name, withTransaction) => {
        expect.assertions(2);

        const { deadlines, timer } = recordingTimer();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reachedHang: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reachedHang = resolve;
        });
        // The row insert hangs until released: the deadline abandons it first, and it commits after.
        const answer = async <R>(query: string, run: () => Promise<R>): Promise<R> => {
            if (query.startsWith('INSERT INTO "posts"')) {
                reachedHang();
                await held;
            }

            return run();
        };
        const exec: SqlCtxExec = {
            all: async (query, parameters) => answer(query, async () => stored.exec.all(query, parameters)),
            run: async (query, parameters) => answer(query, async () => stored.exec.run(query, parameters)),
            ...(withTransaction ? { transaction: async <R>(closure: (on: SqlCtxExec) => Promise<R>): Promise<R> => closure(exec) } : {}),
        };
        let announce: ((table: string) => void) | undefined;
        const announcedLate = new Promise<string>((resolve) => {
            announce = resolve;
        });
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec,
            onWrite: (table, settledLate) => {
                if (settledLate === true) {
                    announce?.(table);
                }
            },
            queryTimeoutMs: 5000,
            queryTimer: timer,
            schema,
        });
        const insert = writer.insert("posts", { title: "late" });

        await hung;

        for (const fire of deadlines) {
            fire();
        }

        await expect(insert).rejects.toBeInstanceOf(SqlQueryTimeoutError);

        release();

        await expect(announcedLate).resolves.toBe("posts");
    });
});

describe("createSqlCtxDb onWrite inside a transaction", () => {
    let stored: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        stored = createSqliteHarness();
    });

    afterEach(() => {
        stored.close();
    });

    it("announces a write that commits with its companions only once the transaction has committed", async () => {
        expect.assertions(1);

        const order: string[] = [];
        const exec: SqlCtxExec = {
            all: async (query, parameters) => stored.exec.all(query, parameters),
            run: async (query, parameters) => stored.exec.run(query, parameters),
            transaction: async <R>(closure: (on: SqlCtxExec) => Promise<R>): Promise<R> => {
                const result = await closure(exec);

                order.push("commit");

                return result;
            },
        };
        // CDC on gives the row a companion statement, so it is written inside a transaction.
        const writer = createSqlCtxDb({
            cdc: true,
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec,
            onWrite: (table) => {
                order.push(`write:${table}`);
            },
            schema,
        });

        await writer.insert("audit", { postId: "p1" });

        expect(order.slice(-2)).toStrictEqual(["commit", "write:audit"]);
    });

    it("announces a write whose transaction commits after its deadline", async () => {
        expect.assertions(2);

        const { deadlines, timer } = recordingTimer();
        let release: () => void = () => undefined;
        const commitHeld = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reachedCommit: () => void = () => undefined;
        const committing = new Promise<void>((resolve) => {
            reachedCommit = resolve;
        });
        const exec: SqlCtxExec = {
            all: async (query, parameters) => stored.exec.all(query, parameters),
            run: async (query, parameters) => stored.exec.run(query, parameters),
            // Every statement has run; COMMIT is what hangs past the deadline, and then succeeds.
            transaction: async <R>(closure: (on: SqlCtxExec) => Promise<R>): Promise<R> => {
                const result = await closure(exec);

                reachedCommit();
                await commitHeld;

                return result;
            },
        };
        let announce: ((table: string) => void) | undefined;
        const announcedLate = new Promise<string>((resolve) => {
            announce = resolve;
        });
        const writer = createSqlCtxDb({
            cdc: true,
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec,
            onWrite: (table, settledLate) => {
                if (settledLate === true) {
                    announce?.(table);
                }
            },
            queryTimeoutMs: 5000,
            queryTimer: timer,
            schema,
        });
        const insert = writer.insert("audit", { postId: "p1" });

        await committing;

        for (const fire of deadlines) {
            fire();
        }

        await expect(insert).rejects.toBeInstanceOf(SqlQueryTimeoutError);

        release();

        await expect(announcedLate).resolves.toBe("audit");
    });
});
