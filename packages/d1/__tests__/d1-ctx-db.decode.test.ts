import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Locks the column encode/decode contract: `serializeColumnValue` JSON-encodes
 * objects/arrays/records and stringifies bigints on write, so `decodeGlobalRow`
 * MUST reverse each case or every read returns the raw storage string. Also
 * covers the explicit-id → tableName cache interaction across a delete and a
 * re-insert into a *different* table.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

// An `v.optional(inner)` column: kind is "optional", the inner validator
// (carrying the real storage kind) lives on `_meta.inner`, mirroring
// `@lunora/values`' `createValidator`. The decode must unwrap to `inner.kind`.
const optionalCol = (innerKind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike =>
    ({
        _meta: { column: { notNull: false, ...column }, inner: { _meta: {}, kind: innerKind } },
        kind: "optional",
    }) as ValidatorLike;

// A table whose columns span every non-scalar storage form the serializer
// encodes: object/array/record → JSON, bigint → decimal string, plus scalar
// boolean/number/string controls that must pass through untouched.
const docsSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            shape: {
                active: col("boolean"),
                big: col("bigint"),
                count: col("number"),
                meta: col("object"),
                name: col("string"),
                settings: col("record"),
                tags: col("array"),
            },
        },
        other: {
            indexes: [],
            shape: {
                label: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setupDocs = (): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "docs" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "active" INTEGER,
            "big" TEXT,
            "count" INTEGER,
            "meta" TEXT,
            "name" TEXT,
            "settings" TEXT,
            "tags" TEXT
        )`,
    );
    harness.ddl(
        `CREATE TABLE "other" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "label" TEXT
        )`,
    );

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: docsSchema });
};

describe("d1 ctx-db — non-scalar column round-trip", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("decodes object/array/record/bigint back to their JS shape via get()", async () => {
        expect.assertions(8);

        const writer = setupDocs();

        await writer.insert(
            "docs",
            {
                _id: "d1",
                active: true,
                big: 9_007_199_254_740_993n,
                count: 7,
                meta: { nested: { y: 2 }, x: 1 },
                name: "hello",
                settings: { dark: true, ratio: 0.5 },
                tags: ["a", "b", "c"],
            },
            { allowExplicitId: true },
        );

        const reloaded = await writer.get("d1");

        expect(reloaded).not.toBeNull();
        // Non-scalar fields must come back as real JS values, not JSON strings.
        expect(reloaded?.["meta"]).toEqual({ nested: { y: 2 }, x: 1 });
        expect(reloaded?.["tags"]).toEqual(["a", "b", "c"]);
        expect(reloaded?.["settings"]).toEqual({ dark: true, ratio: 0.5 });
        // bigint stored as a decimal string must decode back to a bigint.
        expect(reloaded?.["big"]).toBe(9_007_199_254_740_993n);
        // Scalars pass through unchanged.
        expect(reloaded?.["active"]).toBe(true);
        expect(reloaded?.["count"]).toBe(7);
        expect(reloaded?.["name"]).toBe("hello");
    });

    it("decodes non-scalar columns through findMany() and findFirst()", async () => {
        expect.assertions(6);

        const writer = setupDocs();

        await writer.insert(
            "docs",
            { _id: "d2", active: false, big: 42n, count: 1, meta: { a: 1 }, name: "n2", settings: {}, tags: [1, 2] },
            { allowExplicitId: true },
        );

        const { page } = await writer.findMany("docs", { where: { _id: "d2" } });

        expect(page).toHaveLength(1);
        expect(page[0]?.["meta"]).toEqual({ a: 1 });
        expect(page[0]?.["tags"]).toEqual([1, 2]);
        expect(page[0]?.["big"]).toBe(42n);

        const first = await writer.findFirst("docs", { where: { _id: "d2" } });

        expect(first?.["meta"]).toEqual({ a: 1 });
        expect(first?.["big"]).toBe(42n);
    });

    it("round-trips empty arrays/objects without corruption", async () => {
        expect.assertions(3);

        const writer = setupDocs();

        await writer.insert("docs", { _id: "d3", active: true, big: 0n, count: 0, meta: {}, name: "", settings: {}, tags: [] }, { allowExplicitId: true });

        const reloaded = await writer.get("d3");

        expect(reloaded?.["meta"]).toEqual({});
        expect(reloaded?.["tags"]).toEqual([]);
        expect(reloaded?.["big"]).toBe(0n);
    });
});

// A table whose non-scalar columns are wrapped in `v.optional(...)`. The stored
// form is identical to the unwrapped column (object → JSON, bigint → decimal
// string, boolean → 1/0), so the decode must unwrap `optional` to the inner kind
// or every optional non-scalar read returns the raw storage string/number.
const optionalSchema: SchemaLike = {
    tables: {
        opt: {
            indexes: [],
            shape: {
                active: optionalCol("boolean"),
                big: optionalCol("bigint"),
                meta: optionalCol("object"),
                tags: optionalCol("array"),
            },
        },
    },
};

const setupOptional = (): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "opt" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "active" INTEGER,
            "big" TEXT,
            "meta" TEXT,
            "tags" TEXT
        )`,
    );

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: optionalSchema });
};

describe("d1 ctx-db — optional non-scalar column round-trip", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("decodes v.optional(object|array|bigint|boolean) by the inner kind", async () => {
        expect.assertions(4);

        const writer = setupOptional();

        await writer.insert("opt", { _id: "o1", active: true, big: 9_007_199_254_740_993n, meta: { x: 1 }, tags: ["a", "b"] }, { allowExplicitId: true });

        const reloaded = await writer.get("o1");

        // Without unwrapping `optional`, these would come back as the raw JSON
        // string / decimal string / 1 respectively.
        expect(reloaded?.["meta"]).toEqual({ x: 1 });
        expect(reloaded?.["tags"]).toEqual(["a", "b"]);
        expect(reloaded?.["big"]).toBe(9_007_199_254_740_993n);
        expect(reloaded?.["active"]).toBe(true);
    });
});

describe("d1 ctx-db — explicit-id tableName cache", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("re-points the id→table cache after delete + re-insert into a different table", async () => {
        expect.assertions(4);

        const writer = setupDocs();

        // Insert under `docs`, then delete — the delete must drop the stale
        // cache entry so a later re-insert of the SAME id under a different
        // table resolves get()/delete() to the new table, not the old one.
        await writer.insert(
            "docs",
            { _id: "shared", active: true, big: 1n, count: 1, meta: {}, name: "first", settings: {}, tags: [] },
            { allowExplicitId: true },
        );
        await writer.delete("shared");

        await expect(writer.get("shared")).resolves.toBeNull();

        await writer.insert("other", { _id: "shared", label: "second" }, { allowExplicitId: true });

        const reloaded = await writer.get("shared");

        expect(reloaded).not.toBeNull();
        expect(reloaded?.["label"]).toBe("second");
        // The `docs`-only fields must NOT bleed through from the stale entry.
        expect(reloaded?.["name"]).toBeUndefined();
    });
});
