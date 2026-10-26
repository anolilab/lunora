import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Three `.global()` tables, so a lookup that wrongly probed past the named table would show up in the log. The probe log records
 * the table of every `SELECT * FROM <table> WHERE id IN (…)` the writer issues.
 */
const globalTable = {
    indexes: [],
    shape: {
        title: { _meta: { column: { notNull: true } }, kind: "string" } as ValidatorLike,
    },
    shardMode: { kind: "global" },
};

const schema = {
    tables: { a: globalTable, b: globalTable, c: globalTable },
} as never as SchemaLike;

const PROBE = /SELECT \* FROM "(\w+)" WHERE "id" IN \(/u;

let harness: ReturnType<typeof createSqliteHarness>;
let probes: string[];
let writer: ReturnType<typeof createSqlCtxDb>;

describe("createSqlCtxDb id lookup by table", () => {
    beforeEach(() => {
        harness = createSqliteHarness();
        probes = [];

        const exec: SqlCtxExec = {
            ...harness.exec,
            all: (query, parameters) => {
                const match = PROBE.exec(query);

                if (match?.[1] !== undefined) {
                    probes.push(match[1]);
                }

                return harness.exec.all(query, parameters);
            },
        };

        writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec,
            schema,
        });
    });

    afterEach(() => {
        harness.close();
    });

    it("probes only the named table when the id is looked up through it", async () => {
        expect.assertions(2);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const row = await writer.get("b", id);

        expect(probes).toStrictEqual(["b"]);
        expect(row?.["title"]).toBe("in b");
    });

    it("issues one lookup, not one per table, for a `.global()` table", async () => {
        expect.assertions(2);

        const id = await writer.insert("c", { title: "in c" });

        probes = [];

        const row = await writer.get("c", id);

        expect(probes).toHaveLength(1);
        expect(row?.["title"]).toBe("in c");
    });

    it("reads the named table even when another table's answer is cached for the same id", async () => {
        expect.assertions(2);

        // The same id names a row in `a` (written first) and in `b` (written through a writer with a cold cache).
        const id = await writer.insert("a", { title: "in a" });
        const otherWriter = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            schema,
        });

        await otherWriter.insert("b", { title: "in b" }, { clientId: id });

        // Looked up through `b` first, on a writer that has never resolved this id.
        const throughB = await writer.get("b", id);

        expect(throughB?.["title"]).toBe("in b");

        // A read of `a` must not be answered by the cached `b`.
        const throughA = await writer.get("a", id);

        expect(throughA?.["title"]).toBe("in a");
    });

    it("only ever probes the named table across repeated reads", async () => {
        expect.assertions(3);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const first = await writer.get("b", id);
        const second = await writer.get("b", id);

        expect(probes).toStrictEqual(["b", "b"]);
        expect(first?.["title"]).toBe("in b");
        expect(second?.["title"]).toBe("in b");
    });

    it("does not answer a read of a NUL-bearing id from the cache entry of the id it extends", async () => {
        expect.assertions(3);

        // `x` lives in `a`, so the first read caches it. The id `a\u0000x` is not stored anywhere: it is only
        // looked up. The NUL is bound as a parameter, never read back, so this holds on every SQLite build.
        await writer.insert("a", { _id: "x", title: "in a" }, { allowExplicitId: true });

        await expect(writer.get("a", "x")).resolves.toMatchObject({ title: "in a" });

        probes = [];

        const nulBearing = await writer.get("a", "a\u0000x");

        expect(probes).toStrictEqual(["a"]);
        expect(nulBearing).toBeNull();
    });

    it("treats an id owned by another table as absent under the named table", async () => {
        expect.assertions(2);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const row = await writer.get("a", id);

        expect(probes).toStrictEqual(["a"]);
        expect(row).toBeNull();
    });
});

describe("createSqlCtxDb get on a shard-local table", () => {
    it("returns null without reading D1, since a shard-local row never lives there", async () => {
        expect.assertions(2);

        const localHarness = createSqliteHarness();
        const probed: string[] = [];
        const exec: SqlCtxExec = {
            ...localHarness.exec,
            all: (query, parameters) => {
                probed.push(query);

                return localHarness.exec.all(query, parameters);
            },
        };
        const local = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec,
            schema: { tables: { local: { indexes: [], shape: {}, shardMode: { kind: "root" } } } },
        });

        try {
            await expect(local.get("local", "x1")).resolves.toBeNull();
            expect(probed.filter((query) => query.includes('"local"'))).toStrictEqual([]);
        } finally {
            localHarness.close();
        }
    });
});
