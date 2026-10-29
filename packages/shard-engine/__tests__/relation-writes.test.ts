import { describe, expect, it } from "vitest";

import { describeRelationWrites } from "../src/relation-writes";
import type { SchemaLike, ValidatorLike } from "../src/schema-types";

const col = (kind: string, column: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

/** `v.optional(v.id().nullable())`: the shape a key takes when it may be cleared. */
const clearable: ValidatorLike = { _meta: { column: { notNull: true }, inner: col("id", { notNull: false }) }, kind: "optional" };

const schema: SchemaLike = {
    tables: {
        audits: {
            indexes: [],
            relationMap: { user: { field: "userId", kind: "one", references: "_id", table: "users" } },
            shape: { userId: clearable },
            shardMode: { kind: "global" },
        },
        comments: {
            indexes: [],
            relationMap: { post: { field: "postId", kind: "one", references: "_id", table: "posts" } },
            shape: { postId: col("id") },
        },
        orgPosts: {
            indexes: [],
            relationMap: { org: { field: "orgId", kind: "one", references: "_id", table: "orgs" } },
            shape: { orgId: col("id") },
            shardMode: { field: "orgId", kind: "shardBy" },
        },
        orgTags: {
            indexes: [],
            relationMap: { post: { field: "postId", kind: "one", references: "_id", table: "orgPosts" } },
            shape: { postId: col("id") },
            shardMode: { field: "orgId", kind: "shardBy" },
        },
        globalNotes: {
            indexes: [],
            relationMap: { owner: { field: "ownerId", kind: "one", references: "_id", table: "globalOwners" } },
            shape: { ownerId: col("id") },
            shardMode: { kind: "global" },
        },
        globalOwners: { indexes: [], shape: { name: col("string") }, shardMode: { kind: "global" } },
        orgs: { indexes: [], shape: { name: col("string") }, shardMode: { field: "_id", kind: "shardBy" } },
        posts: {
            indexes: [],
            relationMap: {
                author: { field: "authorId", kind: "one", references: "_id", table: "users" },
                comments: { field: "postId", kind: "many", references: "_id", table: "comments" },
            },
            shape: { authorId: clearable },
        },
        users: {
            indexes: [],
            relationMap: {
                audits: { field: "userId", kind: "many", references: "_id", table: "audits" },
                posts: { field: "authorId", kind: "many", references: "_id", table: "posts" },
            },
            shape: { name: col("string") },
        },
    },
};

describe(describeRelationWrites, () => {
    const described = describeRelationWrites(schema);

    it("reads the foreign key's nullability off the table that holds it", () => {
        expect.assertions(4);

        // to-one: the key is on THIS table
        expect(described["posts"]?.["author"]).toMatchObject({ field: "authorId", kind: "one", nullable: true, table: "users" });
        expect(described["comments"]?.["post"]).toMatchObject({ nullable: false });
        // to-many: the key is on the TARGET table
        expect(described["users"]?.["posts"]).toMatchObject({ field: "authorId", kind: "many", nullable: true, table: "posts" });
        expect(described["posts"]?.["comments"]).toMatchObject({ nullable: false });
    });

    it("marks a relation colocated only when both tables share a shard's Durable Object", () => {
        expect.assertions(6);

        expect(described["posts"]?.["author"]?.colocated).toBe(true);
        expect(described["users"]?.["audits"]?.colocated).toBe(false);
        expect(described["audits"]?.["user"]?.colocated).toBe(false);
        // Same shard key: both live on the shard the key selects.
        expect(described["orgTags"]?.["post"]?.colocated).toBe(true);
        // A different shard key (or a root table against a sharded one) is another shard.
        expect(described["orgPosts"]?.["org"]?.colocated).toBe(false);
        // Two `.global()` tables share a backend, but each write is its own commit, so no transaction covers both.
        expect(described["globalNotes"]?.["owner"]?.colocated).toBe(false);
    });

    it("lists only tables that declare a relation", () => {
        expect.assertions(1);

        expect(Object.keys(described).toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
            "audits",
            "comments",
            "globalNotes",
            "orgPosts",
            "orgTags",
            "posts",
            "users",
        ]);
    });
});
