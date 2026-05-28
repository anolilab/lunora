import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { ConflictError } from "../src/transaction.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the write-layer constraint enforcement (column defaults,
 * `$onUpdateFn`, and `.unique()` → ConflictError) against a real SQLite engine
 * — per AGENTS.md these never run against the SQL-string fake, so the UNIQUE
 * breach and `json_extract` default round-trips behave like a Durable Object.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => ({
    _meta: { column: { notNull: true, ...column } },
    kind,
});

let harness: ReturnType<typeof createSqliteExec>;

/**
 * Fresh writer + a `revCalls()` probe over the `$onUpdateFn` counter, so each
 * test can assert whether the factory fired.
 */
const setup = () => {
    let revs = 0;

    const schema: SchemaLike = {
        tables: {
            items: {
                indexes: [],
                shape: {
                    rev: col("number", {
                        onUpdateFn: () => {
                            revs += 1;

                            return revs;
                        },
                    }),
                    seq: col("number", { defaultFn: () => 7 }),
                    slug: col("string", { unique: true }),
                    status: col("string", { defaultValue: "todo" }),
                    title: col("string"),
                },
            },
        },
    };

    runShardMigrations(harness.sql, schema);

    return {
        revCalls: () => revs,
        writer: createShardCtxDb({ clock: () => FIXED_CLOCK, schema, sql: harness.sql }),
    };
};

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("insert defaults", () => {
    test("fills a `.default()` literal and a `.$defaultFn()` factory when absent", async () => {
        const { writer } = setup();

        const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["status"]).toBe("todo");
        expect(doc?.["seq"]).toBe(7);
    });

    test("a provided value overrides the default", async () => {
        const { writer } = setup();

        const id = await writer.insert("items", { _id: "i1", seq: 99, slug: "a", status: "done", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["status"]).toBe("done");
        expect(doc?.["seq"]).toBe(99);
    });

    test("does not run `$onUpdateFn` on insert", async () => {
        const { revCalls, writer } = setup();

        const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["rev"]).toBeUndefined();
        expect(revCalls()).toBe(0);
    });
});

describe("$onUpdateFn", () => {
    test("recomputes on each patch that omits the field", async () => {
        const { revCalls, writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.patch("i1", { title: "second" });

        expect((await writer.get("i1"))?.["rev"]).toBe(1);

        await writer.patch("i1", { title: "third" });

        expect((await writer.get("i1"))?.["rev"]).toBe(2);
        expect(revCalls()).toBe(2);
    });

    test("is skipped when the patch sets the field explicitly", async () => {
        const { revCalls, writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.patch("i1", { rev: 99 });

        expect((await writer.get("i1"))?.["rev"]).toBe(99);
        expect(revCalls()).toBe(0);
    });

    test("recomputes on replace that omits the field, but honors an explicit value", async () => {
        const { writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.replace("i1", { slug: "a", title: "auto" });

        expect((await writer.get("i1"))?.["rev"]).toBe(1);

        await writer.replace("i1", { rev: 42, slug: "a", title: "manual" });

        expect((await writer.get("i1"))?.["rev"]).toBe(42);
    });
});

describe(".unique() constraint", () => {
    test("a duplicate insert throws a ConflictError (code CONFLICT, status 409)", async () => {
        const { writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "dup", title: "first" });

        const conflict = writer.insert("items", { _id: "i2", slug: "dup", title: "second" });

        await expect(conflict).rejects.toBeInstanceOf(ConflictError);
        await expect(conflict).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    });

    test("a patch that collides with another row's unique value conflicts", async () => {
        const { writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "one", title: "first" });
        await writer.insert("items", { _id: "i2", slug: "two", title: "second" });

        await expect(writer.patch("i2", { slug: "one" })).rejects.toBeInstanceOf(ConflictError);
    });

    test("distinct unique values insert cleanly", async () => {
        const { writer } = setup();

        await writer.insert("items", { _id: "i1", slug: "one", title: "first" });
        await writer.insert("items", { _id: "i2", slug: "two", title: "second" });

        await expect(writer.count("items")).resolves.toBe(2);
    });
});
