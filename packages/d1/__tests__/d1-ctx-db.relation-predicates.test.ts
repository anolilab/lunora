import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Relation-crossing `where` predicates on the D1 (column) dialect. The
 * pre-resolver is dialect-agnostic, but D1 stores every field as a real column
 * (not a JSON blob) and has **no** EXISTS push-down — it always semijoins via a
 * batched child fetch. These tests prove the column-SQL rewrite, and that the
 * aggregate/count/groupBy paths resolve a relation node (via the same semijoin)
 * before compiling `where` — so a relation predicate arriving via an RLS read
 * policy is honoured rather than silently mis-compiled (a fail-**open** hazard).
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["authorId"], name: "by_author" }],
            relationMap: {
                author: { field: "authorId", kind: "one", references: "_id", table: "users" },
            },
            shape: { authorId: col("string", { notNull: false }), body: col("string") },
        },
        users: {
            indexes: [],
            relationMap: {
                messages: { field: "authorId", kind: "many", references: "_id", table: "messages" },
            },
            shape: { name: col("string") },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setup = (): DatabaseWriterLike => {
    harness.ddl(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "name" TEXT)`);
    harness.ddl(`CREATE TABLE "messages" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "authorId" TEXT, "body" TEXT)`);

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
    await writer.insert("users", { _id: "u2", name: "Linus" }, { allowExplicitId: true });
    await writer.insert("users", { _id: "u3", name: "Loner" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "mNull", authorId: null, body: "void" }, { allowExplicitId: true });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]).toSorted((a, b) => String(a).localeCompare(String(b)));

describe("d1 relation predicates (semijoin pre-resolution)", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("to-one `is` rewrites to a column IN over the resolved child keys", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        const { page } = await writer.findMany("messages", { where: { author: { is: { name: "Ada" } } } });

        expect(ids(page)).toStrictEqual(["m1", "m2"]);
    });

    it("to-many `some` matches parents with at least one readable child", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        const { page } = await writer.findMany("users", { where: { messages: { some: { body: "hey" } } } });

        expect(ids(page)).toStrictEqual(["u2"]);
    });

    it("to-many `none` includes childless parents (NOT IN [] → 1 = 1)", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        const { page } = await writer.findMany("users", { where: { messages: { none: { body: "hi" } } } });

        // u2 (only "hey") and u3 (childless) have no "hi" message; u1 does.
        expect(ids(page)).toStrictEqual(["u2", "u3"]);
    });

    it("to-one `isNot` includes the null-FK row (no related record)", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        const { page } = await writer.findMany("messages", { where: { author: { isNot: { name: "Ada" } } } });

        // m3 (Linus) and mNull (no author) — not Ada's m1/m2.
        expect(ids(page)).toStrictEqual(["m3", "mNull"]);
    });

    it("count() resolves a relation predicate via the column semijoin", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        // u1 and u2 authored messages; u3 (Loner) didn't. `some: {}` matches
        // every user with at least one (readable) message.
        await expect(writer.count("users", { messages: { some: {} } })).resolves.toBe(2);
    });

    it("aggregate({ op: count }) resolves a relation predicate before reducing", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        // Only u2 (Linus) authored "hey"; the count delegation carries the
        // relation predicate through the semijoin pre-resolver.
        await expect(writer.aggregate("users", { op: "count", where: { messages: { some: { body: "hey" } } } })).resolves.toBe(1);
    });

    it("rankPage() rejects a relation predicate instead of silently dropping it", async () => {
        expect.assertions(1);

        const writer = setup();

        await seed(writer);

        // rankPage's `where` only pins the partition — never a row filter — so a
        // relation predicate would fail open. The guard fires before the rankIndex
        // lookup (parity with the DO twin), so it rejects even without one.
        await expect(writer.rankPage("messages", "by_author", { where: { author: { is: { name: "Ada" } } } })).rejects.toThrow(/not supported in rankPage/u);
    });
});
