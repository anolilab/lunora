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

const noLocalSql: SqlExec = {
    exec: () => {
        throw new Error("a global read must not touch the shard-local SQLite");
    },
};

/** A replica session that has not caught up: every read of the table comes back empty, while `primary` reads the store. */
const laggingReplicaOf = (plain: SqlCtxExec): SqlCtxExec => {
    return {
        ...plain,
        all: async (text, parameters) => (text.includes(`"${TABLE}"`) ? [] : plain.all(text, parameters)),
        primary: plain,
    };
};

/**
 * A D1 `first-primary` session: only its first read reaches the primary. Later reads come from a
 * replica that has not caught up, so a session reused across primary reads can miss a later commit.
 */
const firstPrimarySession = (plain: SqlCtxExec): SqlCtxExec => {
    let reads = 0;

    return {
        ...plain,
        all: async (text, parameters) => {
            reads += 1;

            return reads === 1 || !text.includes(`"${TABLE}"`) ? plain.all(text, parameters) : [];
        },
    };
};

describe("a global read that asks for the primary", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    /** Provision the table and commit one row through the plain exec, as the primary would hold it. */
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
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplicaOf(harness.exec), provisionScope, schema });

        await expect(store.findMany(TABLE, {})).resolves.toMatchObject({ page: [] });
        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });

    it("finds the row through findFirst, the call a policy check makes", async () => {
        expect.assertions(2);

        const provisionScope = await provisionAndWrite();
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplicaOf(harness.exec), provisionScope, schema });

        await expect(store.findFirst(TABLE, {})).resolves.toBeNull();
        await expect(store.findFirst(TABLE, { consistency: "primary" })).resolves.toMatchObject({ label: "locked" });
    });

    it("sees a commit made between two primary reads in one request, because each read opens a fresh session", async () => {
        expect.assertions(2);

        const provisionScope = await provisionAndWrite();
        const exec: SqlCtxExec = {
            ...laggingReplicaOf(harness.exec),
            get primary() {
                return firstPrimarySession(harness.exec);
            },
        };
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec, provisionScope, schema });

        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });

        await harness.exec.run(`INSERT INTO "${TABLE}" (id, _creationTime, _version, bucket, label) VALUES ('b', 2, 0, 1, 'second')`, []);

        const { page } = await store.findMany(TABLE, { consistency: "primary" });

        expect(page.map((row) => row["label"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["locked", "second"]);
    });

    it("keeps the migration gate off the primary session when the writer has no provisionScope", async () => {
        expect.assertions(1);

        await provisionAndWrite();
        const exec: SqlCtxExec = {
            ...laggingReplicaOf(harness.exec),
            get primary() {
                return firstPrimarySession(harness.exec);
            },
        };
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec, schema });

        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });

    it("reads the same store when the exec has no primary session", async () => {
        expect.assertions(1);

        await provisionAndWrite();
        const store = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: harness.exec, schema });

        await expect(store.findMany(TABLE, { consistency: "primary" })).resolves.toMatchObject({ page: [{ label: "locked" }] });
    });

    it("forwards consistency: primary from findFirst and an unlimited findMany through the shard router", async () => {
        expect.assertions(3);

        const provisionScope = await provisionAndWrite();
        const globalDb = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplicaOf(harness.exec), provisionScope, schema });
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

    it("charges no rows to the read headroom for a primary read that matches nothing", async () => {
        expect.assertions(1);

        const provisionScope = await provisionAndWrite();
        const globalDb = createSqlCtxDb({ clock, dialect: makeSqliteDialect(), exec: laggingReplicaOf(harness.exec), provisionScope, schema });
        const headroom = new TransactionHeadroomTracker({});
        const router = createShardCtxDb({ clock, globalDb, headroom, schema, sql: noLocalSql });

        await router.findMany(TABLE, { consistency: "primary", where: { label: "absent" } });

        expect(headroom.headroom().readRows).toBe(0);
    });
});
