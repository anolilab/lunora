import type { SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const TABLE = "items";

const schema = {
    tables: {
        [TABLE]: {
            indexes: [],
            shape: {
                bucket: { _meta: { column: { notNull: true } }, kind: "number" },
                label: { _meta: { column: { notNull: true } }, kind: "string" },
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

const clock = (): number => 1_700_000_000_000;

/**
 * A D1-shaped exec whose replica session has not caught up: every read of the table comes back
 * empty, while `primary` reads the store the write went to. The write goes through the plain exec.
 */
describe("a global findMany that asks for a primary read", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const provisionAndWrite = async (): Promise<object> => {
        const provisionScope = {};
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: harness.exec, provisionScope, schema });

        await store.findMany(TABLE, { limit: 1 });
        await harness.exec.run(`INSERT INTO "${TABLE}" (id, _creationTime, _version, bucket, label) VALUES ('a', 1, 0, 1, 'locked')`, []);

        return provisionScope;
    };

    it("misses a just-committed row on the replica, and finds it with consistency: primary", async () => {
        expect.assertions(2);

        const provisionScope = await provisionAndWrite();
        const plain = harness.exec;
        const laggingReplica: SqlCtxExec = {
            ...plain,
            all: async (text, parameters) => (text.includes(`"${TABLE}"`) ? [] : plain.all(text, parameters)),
            primary: plain,
        };
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplica, provisionScope, schema });

        await expect(store.findMany(TABLE, {})).resolves.toMatchObject({ page: [] });
        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });

    it("finds the row through findFirst, the call a policy check makes", async () => {
        expect.assertions(2);

        const provisionScope = await provisionAndWrite();
        const plain = harness.exec;
        const laggingReplica: SqlCtxExec = {
            ...plain,
            all: async (text, parameters) => (text.includes(`"${TABLE}"`) ? [] : plain.all(text, parameters)),
            primary: plain,
        };
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplica, provisionScope, schema });

        await expect(store.findFirst(TABLE, {})).resolves.toBeNull();
        await expect(store.findFirst(TABLE, { consistency: "primary" })).resolves.toMatchObject({ label: "locked" });
    });

    it("reads the same store when the exec has no primary session", async () => {
        expect.assertions(1);

        await provisionAndWrite();
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: harness.exec, schema });

        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });
});

describe("a primary read through the shard router, which is how ctx.db reaches a .global() table", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("forwards consistency: primary from findFirst and an unlimited findMany to the global writer", async () => {
        expect.assertions(3);

        const provisionScope = {};
        const plain = harness.exec;
        const provisioned = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: plain, provisionScope, schema });

        await provisioned.findMany(TABLE, { limit: 1 });
        await plain.run(`INSERT INTO "${TABLE}" (id, _creationTime, _version, bucket, label) VALUES ('a', 1, 0, 1, 'locked')`, []);

        const laggingReplica: SqlCtxExec = {
            ...plain,
            all: async (text, parameters) => (text.includes(`"${TABLE}"`) ? [] : plain.all(text, parameters)),
            primary: plain,
        };
        const globalDb = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplica, provisionScope, schema });
        const noLocalSql: SqlExec = {
            exec: () => {
                throw new Error("a global read must not touch the shard-local SQLite");
            },
        };
        const router = createShardCtxDb({
            clock,
            globalDb,
            headroom: new TransactionHeadroomTracker({}),
            schema,
            sql: noLocalSql,
        });

        await expect(router.findFirst(TABLE, {})).resolves.toBeNull();
        await expect(router.findFirst(TABLE, { consistency: "primary" })).resolves.toMatchObject({ label: "locked" });
        await expect(router.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });
});
