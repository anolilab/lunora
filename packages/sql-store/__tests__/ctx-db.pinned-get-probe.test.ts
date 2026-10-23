import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Three `.global()` tables, so an unpinned id lookup has more than one table to probe. The probe log records
 * the table of every `SELECT 1 FROM <table> WHERE id = …` the writer issues.
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

const PROBE = /SELECT 1 FROM "(\w+)" WHERE "id" = /u;

let harness: ReturnType<typeof createSqliteHarness>;
let probes: string[];
let writer: ReturnType<typeof createSqlCtxDb>;

describe("createSqlCtxDb id lookup under a table pin", () => {
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

    it("probes only the pinned table when the id is looked up through its table", async () => {
        expect.assertions(2);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const row = await writer.get(id, "b");

        expect(probes).toStrictEqual(["b"]);
        expect(row?.["title"]).toBe("in b");
    });

    it("probes every table when the id is looked up without a pin", async () => {
        expect.assertions(2);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const row = await writer.get(id);

        expect(probes.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["a", "b", "c"]);
        expect(row?.["title"]).toBe("in b");
    });

    it("reads the id's own table under a pin even when another table's answer is cached for it", async () => {
        expect.assertions(3);

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
        const throughB = await writer.get(id, "b");

        expect(throughB?.["title"]).toBe("in b");

        // A pinned read of `a` must not be answered by the cached `b`, and an unpinned read keeps the first match in schema order.
        const throughA = await writer.get(id, "a");
        const unpinned = await writer.get(id);

        expect(throughA?.["title"]).toBe("in a");
        expect(unpinned?.["title"]).toBe("in a");
    });

    it("does not probe again for a repeated pinned read of the same table", async () => {
        expect.assertions(3);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const first = await writer.get(id, "b");
        const second = await writer.get(id, "b");

        expect(probes).toStrictEqual(["b"]);
        expect(first?.["title"]).toBe("in b");
        expect(second?.["title"]).toBe("in b");
    });

    it("treats an id owned by another table as absent under a pin", async () => {
        expect.assertions(2);

        const id = await writer.insert("b", { title: "in b" });

        probes = [];

        const row = await writer.get(id, "a");

        expect(probes).toStrictEqual(["a"]);
        expect(row).toBeNull();
    });
});
