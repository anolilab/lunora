import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { deriveRelationEdges, RELATED_MAX_DEPTH, RELATED_MAX_LIMIT } from "../src/relation-graph";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises the schema-derived relation graph — edge derivation and the
 * `ctx.db.related(...)` walk — against a real SQLite engine, per AGENTS.md
 * (never against a SQL-string fake). The traversal issues nothing but ordinary
 * `findMany` reads, so proving it here proves the same code path every backend
 * takes.
 */

let harness: ReturnType<typeof createSqliteExec>;

/** A `v.id("target")` column as the runtime validator surface exposes it. */
const idColumn = (tableName: string): { _meta: { tableName: string }; kind: string } => {
    return { _meta: { tableName }, kind: "id" };
};

/** `v.optional(v.id("target"))`. */
const optionalIdColumn = (tableName: string): { _meta: { inner: ReturnType<typeof idColumn> }; kind: string } => {
    return {
        _meta: { inner: idColumn(tableName) },
        kind: "optional",
    };
};

/** `v.array(v.id("target"))`. */
const arrayIdColumn = (tableName: string): { _meta: { inner: ReturnType<typeof idColumn> }; kind: string } => {
    return {
        _meta: { inner: idColumn(tableName) },
        kind: "array",
    };
};

const text = { kind: "string" } as const;

/**
 * customers ←— tickets ←— messages, plus a `v.array(v.id("tags"))` on tickets
 * and an optional `customers.primaryTicketId` that closes a customers ⇄ tickets
 * cycle.
 */
const schema: SchemaLike = {
    tables: {
        customers: {
            indexes: [],
            shape: { name: text, primaryTicketId: optionalIdColumn("tickets") },
        },
        messages: {
            indexes: [{ fields: ["ticketId"], name: "by_ticket" }],
            shape: { body: text, ticketId: idColumn("tickets") },
        },
        tags: { indexes: [], shape: { label: text } },
        tickets: {
            indexes: [{ fields: ["customerId"], name: "by_customer" }],
            shape: { customerId: idColumn("customers"), subject: text, tagIds: arrayIdColumn("tags") },
        },
    },
};

const makeWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("customers", { _id: "c1", name: "Ada", primaryTicketId: "t1" }, { allowExplicitId: true });
    await writer.insert("customers", { _id: "c2", name: "Linus" }, { allowExplicitId: true });
    await writer.insert("tags", { _id: "g1", label: "billing" }, { allowExplicitId: true });
    await writer.insert("tickets", { _id: "t1", customerId: "c1", subject: "Invoice", tagIds: ["g1"] }, { allowExplicitId: true });
    await writer.insert("tickets", { _id: "t2", customerId: "c1", subject: "Refund", tagIds: [] }, { allowExplicitId: true });
    await writer.insert("tickets", { _id: "t3", customerId: "c2", subject: "Other", tagIds: [] }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m1", body: "hello", ticketId: "t1" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m2", body: "again", ticketId: "t1" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m3", body: "other", ticketId: "t3" }, { allowExplicitId: true });
};

/** `related` is optional on the structural writer; every test here needs it. */
const relatedOf = (writer: DatabaseWriterLike): NonNullable<DatabaseWriterLike["related"]> => {
    const { related } = writer;

    if (!related) {
        throw new Error("the shard writer must implement `related`");
    }

    return related;
};

describe("deriveRelationEdges", () => {
    it("derives one named edge per v.id column, unwrapping optional and array", () => {
        expect.assertions(1);

        expect(deriveRelationEdges(schema)).toStrictEqual([
            { array: false, column: "primaryTicketId", name: "customers.primaryTicketId", sourceTable: "customers", targetTable: "tickets" },
            { array: false, column: "ticketId", name: "messages.ticketId", sourceTable: "messages", targetTable: "tickets" },
            { array: false, column: "customerId", name: "tickets.customerId", sourceTable: "tickets", targetTable: "customers" },
            { array: true, column: "tagIds", name: "tickets.tagIds", sourceTable: "tickets", targetTable: "tags" },
        ]);
    });

    it("drops an edge whose target table the schema does not declare", () => {
        expect.assertions(1);

        const dangling: SchemaLike = {
            tables: { notes: { indexes: [], shape: { archiveId: idColumn("archive"), body: text } } },
        };

        expect(deriveRelationEdges(dangling)).toStrictEqual([]);
    });

    it("ignores a non-id column and an id buried in a structure it cannot filter on", () => {
        expect.assertions(1);

        const buried: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    // `_meta` carries only what the edge derivation reads, so an
                    // object's property map is cast in: the point of the case is
                    // that a nested id is NOT an edge however it is spelled.
                    shape: {
                        body: text,
                        meta: { _meta: { shape: { ownerId: idColumn("users") } } as never, kind: "object" },
                    },
                },
                users: { indexes: [], shape: { name: text } },
            },
        };

        expect(deriveRelationEdges(buried)).toStrictEqual([]);
    });
});

describe("ctx-db related", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("direction", () => {
        it("follows the ids a row HOLDS with direction: out", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "t1", table: "tickets" }, { direction: "out" });

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["c1", "g1"]);
            expect(page.nodes.map((node) => node.path)).toStrictEqual([["tickets.customerId"], ["tickets.tagIds"]]);
        });

        it("follows the rows that POINT AT a row with direction: in", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "c1", table: "customers" }, { direction: "in" });

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["t1", "t2"]);
            expect(page.nodes.every((node) => node.table === "tickets")).toBe(true);
        });

        it("unions both directions by default", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "t1", table: "tickets" });

            // customers.primaryTicketId (in) + messages.ticketId (in) + tickets.customerId (out) + tickets.tagIds (out)
            expect(new Set(page.nodes.map((node) => node.document["_id"]))).toStrictEqual(new Set(["c1", "g1", "m1", "m2"]));
        });

        it("follows an array id column outward only", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            const outward = await relatedOf(writer)({ id: "t1", table: "tickets" }, { direction: "out", edges: ["tickets.tagIds"] });
            const inward = await relatedOf(writer)({ id: "g1", table: "tags" }, { direction: "in", edges: ["tickets.tagIds"] });

            expect(outward.nodes.map((node) => node.document["_id"])).toStrictEqual(["g1"]);
            // No array-containment operator exists in `where`, so the holders of
            // an array FK are deliberately unreachable rather than table-scanned.
            expect(inward.nodes).toStrictEqual([]);
        });
    });

    describe("depth", () => {
        it("expands multiple hops and decays the score per hop", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "c2", table: "customers" }, { depth: 2, direction: "in" });

            expect(page.nodes.map((node) => [node.document["_id"], node.depth, node.score])).toStrictEqual([
                ["t3", 1, 1],
                ["m3", 2, 0.5],
            ]);
            expect(page.nodes.at(-1)?.path).toStrictEqual(["tickets.customerId", "messages.ticketId"]);
        });

        it("records the full id path from the start node", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "c2", table: "customers" }, { depth: 2, direction: "in" });

            expect(page.nodes.at(-1)?.pathIds).toStrictEqual(["c2", "t3", "m3"]);
        });

        it("refuses a depth beyond the documented cap instead of clamping", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            await expect(relatedOf(writer)({ id: "c1", table: "customers" }, { depth: RELATED_MAX_DEPTH + 1 })).rejects.toThrow(
                /`depth` must be an integer between 1 and 4/u,
            );
            await expect(relatedOf(writer)({ id: "c1", table: "customers" }, { depth: 0 })).rejects.toThrow(/`depth` must be an integer/u);
        });

        it("refuses a limit beyond the documented cap", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(relatedOf(writer)({ id: "c1", table: "customers" }, { limit: RELATED_MAX_LIMIT + 1 })).rejects.toThrow(
                /`limit` must be an integer between 1 and 200/u,
            );
        });
    });

    describe("cycle safety", () => {
        it("terminates on a cyclic schema and never revisits a node", async () => {
            expect.assertions(2);

            const writer = makeWriter();

            await seed(writer);

            // customers.primaryTicketId → tickets, tickets.customerId → customers:
            // a two-table cycle walked at the maximum depth.
            const page = await relatedOf(writer)(
                { id: "c1", table: "customers" },
                { depth: RELATED_MAX_DEPTH, edges: ["customers.primaryTicketId", "tickets.customerId"] },
            );
            const ids = page.nodes.map((node) => node.document["_id"]);

            expect(ids).toStrictEqual(["t1", "t2"]);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    describe("edges", () => {
        it("restricts the walk to the named edge types", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)({ id: "t1", table: "tickets" }, { edges: ["messages.ticketId"] });

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["m1", "m2"]);
        });

        it("refuses an edge name the schema does not declare", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(relatedOf(writer)({ id: "t1", table: "tickets" }, { edges: ["tickets.ownerId"] })).rejects.toThrow(
                /unknown edge name: tickets\.ownerId/u,
            );
        });
    });

    describe("start node", () => {
        it("accepts a loaded document and resolves its table", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const ticket = await writer.get("t1", "tickets");
            const page = await relatedOf(writer)(ticket as Record<string, unknown>, { direction: "out", edges: ["tickets.customerId"] });

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["c1"]);
        });

        it("reports an absent start row as NOT_FOUND rather than an empty page", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(relatedOf(writer)({ id: "nope", table: "customers" })).rejects.toThrow(/no "customers" row with id nope/u);
        });
    });

    describe("pagination", () => {
        it("pages through the traversal with the returned cursor", async () => {
            expect.assertions(4);

            const writer = makeWriter();

            await seed(writer);

            const first = await relatedOf(writer)({ id: "t1", table: "tickets" }, { edges: ["messages.ticketId"], limit: 1 });

            expect(first.nodes.map((node) => node.document["_id"])).toStrictEqual(["m1"]);
            expect(first.isDone).toBe(false);

            const second = await relatedOf(writer)({ id: "t1", table: "tickets" }, { cursor: first.continueCursor, edges: ["messages.ticketId"], limit: 1 });

            expect(second.nodes.map((node) => node.document["_id"])).toStrictEqual(["m2"]);
            expect(second.isDone).toBe(true);
        });
    });

    describe("read filters", () => {
        it("applies the per-table relationBaseWhere to every hop", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const page = await relatedOf(writer)(
                { id: "t1", table: "tickets" },
                { direction: "in", edges: ["messages.ticketId"], relationBaseWhere: (table) => (table === "messages" ? { body: "hello" } : undefined) },
            );

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["m1"]);
        });

        it("hides a start row the policy filter excludes", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(
                relatedOf(writer)({ id: "t1", table: "tickets" }, { relationBaseWhere: (table) => (table === "tickets" ? { subject: "nothing" } : undefined) }),
            ).rejects.toThrow(/no "tickets" row with id t1/u);
        });
    });
});

describe("ctx-db related — sql exec surface", () => {
    it("uses the writer's own reads, so a fresh writer over the same sql sees the same graph", async () => {
        expect.assertions(1);

        harness = createSqliteExec();

        try {
            const writer = makeWriter();

            await seed(writer);

            const second = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
            const page = await relatedOf(second)({ id: "c1", table: "customers" }, { direction: "in" });

            expect(page.nodes.map((node) => node.document["_id"])).toStrictEqual(["t1", "t2"]);
        } finally {
            harness.close();
        }
    });
});
