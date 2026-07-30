import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Per-relation `select` on `with` loads: a relation's children are projected
 * down to the chosen fields (plus `_id`/`_creationTime`), trimming the wire
 * payload while the join key stays available for grouping. Exercised over real
 * SQLite for both a `one` and a `many` relation.
 */
const schema: SchemaLike = {
    tables: {
        posts: {
            indexes: [],
            relationMap: { author: { field: "authorId", kind: "one", references: "_id", table: "users" } },
            shape: { authorId: { kind: "string" }, body: { kind: "string" }, title: { kind: "string" } },
        },
        users: {
            indexes: [],
            relationMap: { posts: { field: "authorId", kind: "many", references: "_id", table: "posts" } },
            shape: { email: { kind: "string" }, name: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setup = async (): Promise<DatabaseWriterLike> => {
    runShardMigrations(harness.sql, schema);

    const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

    await writer.insert("users", { _id: "u1", email: "ada@x.dev", name: "Ada" }, { allowExplicitId: true });
    await writer.insert("posts", { _id: "p1", authorId: "u1", body: "b1", title: "t1" }, { allowExplicitId: true });
    await writer.insert("posts", { _id: "p2", authorId: "u1", body: "b2", title: "t2" }, { allowExplicitId: true });

    return writer;
};

describe("ctx-db with: per-relation select", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("projects a `one` relation's loaded child", async () => {
        expect.assertions(1);

        const writer = await setup();
        const { page } = await writer.findMany("posts", { where: { _id: "p1" }, with: { author: { select: ["name"] } } });

        // The loaded author carries only the selected field + system fields — no email.
        expect(page[0]?.["author"]).toStrictEqual({ _creationTime: 1_700_000_000_000, _id: "u1", name: "Ada" });
    });

    it("projects each child of a `many` relation", async () => {
        expect.assertions(2);

        const writer = await setup();
        const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { posts: { select: ["title"] } } });
        const posts = page[0]?.["posts"] as Record<string, unknown>[];

        expect(posts.map((post) => Object.keys(post).toSorted((a, b) => a.localeCompare(b)))).toStrictEqual([
            ["_creationTime", "_id", "title"],
            ["_creationTime", "_id", "title"],
        ]);
        expect(posts.map((post) => post["title"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["t1", "t2"]);
    });

    it("loads the full child when no select is given", async () => {
        expect.assertions(1);

        const writer = await setup();
        const { page } = await writer.findMany("posts", { where: { _id: "p1" }, with: { author: true } });

        expect(Object.keys(page[0]?.["author"] as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "_creationTime",
            "_id",
            "email",
            "name",
        ]);
    });
});
