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

describe("ctx-db constraints", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("insert defaults", () => {
        test("fills a `.default()` literal and a `.$defaultFn()` factory when absent", async () => {
            expect.assertions(2);

            const { writer } = setup();

            const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["status"]).toBe("todo");
            expect(doc?.["seq"]).toBe(7);
        });

        test("a provided value overrides the default", async () => {
            expect.assertions(2);

            const { writer } = setup();

            const id = await writer.insert("items", { _id: "i1", seq: 99, slug: "a", status: "done", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["status"]).toBe("done");
            expect(doc?.["seq"]).toBe(99);
        });

        test("does not run `$onUpdateFn` on insert", async () => {
            expect.assertions(2);

            const { revCalls, writer } = setup();

            const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["rev"]).toBeUndefined();
            expect(revCalls()).toBe(0);
        });
    });

    describe("$onUpdateFn", () => {
        test("recomputes on each patch that omits the field", async () => {
            expect.assertions(3);

            const { revCalls, writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.patch("i1", { title: "second" });

            expect((await writer.get("i1"))?.["rev"]).toBe(1);

            await writer.patch("i1", { title: "third" });

            expect((await writer.get("i1"))?.["rev"]).toBe(2);
            expect(revCalls()).toBe(2);
        });

        test("is skipped when the patch sets the field explicitly", async () => {
            expect.assertions(2);

            const { revCalls, writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.patch("i1", { rev: 99 });

            expect((await writer.get("i1"))?.["rev"]).toBe(99);
            expect(revCalls()).toBe(0);
        });

        test("recomputes on replace that omits the field, but honors an explicit value", async () => {
            expect.assertions(2);

            const { writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.replace("i1", { slug: "a", title: "auto" });

            expect((await writer.get("i1"))?.["rev"]).toBe(1);

            await writer.replace("i1", { rev: 42, slug: "a", title: "manual" });

            expect((await writer.get("i1"))?.["rev"]).toBe(42);
        });
    });

    describe(".unique() constraint", () => {
        test("a duplicate insert throws a ConflictError (code CONFLICT, status 409)", async () => {
            expect.assertions(2);

            const { writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "dup", title: "first" }, { allowExplicitId: true });

            const conflict = writer.insert("items", { _id: "i2", slug: "dup", title: "second" }, { allowExplicitId: true });

            await expect(conflict).rejects.toBeInstanceOf(ConflictError);
            await expect(conflict).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
        });

        test("a patch that collides with another row's unique value conflicts", async () => {
            expect.assertions(1);

            const { writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "one", title: "first" }, { allowExplicitId: true });
            await writer.insert("items", { _id: "i2", slug: "two", title: "second" }, { allowExplicitId: true });

            await expect(writer.patch("i2", { slug: "one" })).rejects.toBeInstanceOf(ConflictError);
        });

        test("distinct unique values insert cleanly", async () => {
            expect.assertions(1);

            const { writer } = setup();

            await writer.insert("items", { _id: "i1", slug: "one", title: "first" }, { allowExplicitId: true });
            await writer.insert("items", { _id: "i2", slug: "two", title: "second" }, { allowExplicitId: true });

            await expect(writer.count("items")).resolves.toBe(2);
        });
    });

    describe("composite UNIQUE indexes", () => {
        /**
         * `.index(name, fields, {unique: true})` already supports multiple fields —
         * `runShardMigrations` writes `CREATE UNIQUE INDEX ... ON tbl (a, b)`. This
         * test pins that end-to-end so a regression in the index emitter or the
         * write-layer ConflictError mapping surfaces immediately.
         */
        const setupTenantSlug = () => {
            const schema: SchemaLike = {
                tables: {
                    pages: {
                        indexes: [{ fields: ["tenantId", "slug"] as const, name: "by_tenant_slug", unique: true }],
                        shape: {
                            slug: col("string"),
                            tenantId: col("string"),
                            title: col("string"),
                        },
                    },
                },
            };

            runShardMigrations(harness.sql, schema);

            return createShardCtxDb({ clock: () => FIXED_CLOCK, schema, sql: harness.sql });
        };

        test("(tenantId, slug) duplicate inserts conflict; differing in either column is allowed", async () => {
            expect.assertions(2);

            const writer = setupTenantSlug();

            await writer.insert("pages", { _id: "p1", slug: "home", tenantId: "t1", title: "Acme home" }, { allowExplicitId: true });

            const collide = writer.insert("pages", { _id: "p2", slug: "home", tenantId: "t1", title: "duplicate" }, { allowExplicitId: true });

            await expect(collide).rejects.toBeInstanceOf(ConflictError);

            // Same slug under a different tenant is allowed.
            await writer.insert("pages", { _id: "p3", slug: "home", tenantId: "t2", title: "Other home" }, { allowExplicitId: true });
            // Same tenant with a different slug is allowed.
            await writer.insert("pages", { _id: "p4", slug: "pricing", tenantId: "t1", title: "Pricing" }, { allowExplicitId: true });

            await expect(writer.count("pages")).resolves.toBe(3);
        });

        test("a patch that creates a (tenantId, slug) collision is rejected", async () => {
            expect.assertions(1);

            const writer = setupTenantSlug();

            await writer.insert("pages", { _id: "p1", slug: "a", tenantId: "t1", title: "A" }, { allowExplicitId: true });
            await writer.insert("pages", { _id: "p2", slug: "b", tenantId: "t1", title: "B" }, { allowExplicitId: true });

            await expect(writer.patch("p2", { slug: "a" })).rejects.toBeInstanceOf(ConflictError);
        });
    });

    describe("write-time refinements (`.check()` on column validators)", () => {
        /**
         * Build a validator whose `parse()` runs the user predicate, mirroring
         * what `@cirrus/values`' `.check()` returns. The DO ctx-db package has no
         * runtime dep on `@cirrus/values` (kept light on purpose), so unit tests
         * pass a structural fake — same shape, hand-rolled `parse`.
         */
        const checked = <T>(kind: string, predicate: (value: T) => boolean, message: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => ({
            _meta: { column: { notNull: true, ...column } },
            kind,
            parse(value) {
                if (!predicate(value as T)) {
                    const error: Error & { code?: string } = new Error(message);

                    error.code = "VALIDATION";

                    throw error;
                }

                return value;
            },
        });

        const setupCheck = () => {
            const schema: SchemaLike = {
                tables: {
                    orders: {
                        indexes: [],
                        shape: {
                            amount: checked<number>("number", (n) => n >= 0, "amount must be non-negative"),
                            sku: col("string"),
                            status: col("string", { defaultValue: "pending" }),
                        },
                    },
                },
            };

            runShardMigrations(harness.sql, schema);

            return createShardCtxDb({ clock: () => FIXED_CLOCK, schema, sql: harness.sql });
        };

        test("insert rejects a row that fails the refinement", async () => {
            expect.assertions(1);

            const writer = setupCheck();

            await expect(writer.insert("orders", { amount: -1, sku: "X" })).rejects.toThrow(/non-negative/u);
        });

        test("insert accepts a row that passes the refinement", async () => {
            expect.assertions(2);

            const writer = setupCheck();

            const id = await writer.insert("orders", { _id: "o1", amount: 42, sku: "OK" }, { allowExplicitId: true });

            expect(id).toBe("o1");
            await expect(writer.count("orders")).resolves.toBe(1);
        });

        test("patch that flips a field to an invalid value is rejected", async () => {
            expect.assertions(2);

            const writer = setupCheck();

            await writer.insert("orders", { _id: "o1", amount: 10, sku: "X" }, { allowExplicitId: true });

            await expect(writer.patch("o1", { amount: -5 })).rejects.toThrow(/non-negative/u);
            // Prior row must remain unchanged after the rejection.
            await expect(writer.get("o1")).resolves.toMatchObject({ amount: 10 });
        });

        test("replace runs refinements after applyOnUpdate so defaulted fields are checked", async () => {
            expect.assertions(1);

            const writer = setupCheck();

            await writer.insert("orders", { _id: "o1", amount: 10, sku: "X" }, { allowExplicitId: true });

            await expect(writer.replace("o1", { amount: -1, sku: "X" })).rejects.toThrow(/non-negative/u);
        });
    });
});
