/*
 * createPolicyDsl — the project-bound, relation-aware definePolicy that codegen
 * emits into _generated/server.ts. These tests pin two contracts:
 *
 * 1. The runtime is byte-for-byte the untyped definePolicy — a policy built
 *    through the bound DSL is an ordinary { on, table, when } the rls() chain
 *    discovers identically.
 * 2. The typed surface accepts a Prisma-style relation predicate as a read
 *    decision (the @lunora/do pre-resolver resolves it on reads), constrains
 *    table to a real table name, and type-checks when's return.
 *
 * The type-level expectations are asserted with ts-expect-error so a regression
 * that widens the surface fails the type check, not just at runtime.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { createPolicyDsl } from "../src/index";

interface PostsDoc {
    _id: string;
    authorId: string;
    title: string;
}

interface UsersDoc {
    _id: string;
    name: string;
    orgId: string;
}

interface DataModel {
    posts: PostsDoc;
    users: UsersDoc;
}

interface Relations {
    posts: {
        author: { __relationKind: "one"; __target: "users" };
    };
    users: {
        posts: { __relationKind: "many"; __target: "posts" };
    };
}

const definePolicy = createPolicyDsl<DataModel, Relations>();

describe("createPolicyDsl — relation-aware typed definePolicy", () => {
    it("builds the same plain { on, table, when } shape as the untyped constructor", () => {
        expect.assertions(3);

        const when = (): boolean => true;
        const policy = definePolicy({ on: "read", table: "posts", when });

        expect(policy.on).toBe("read");
        expect(policy.table).toBe("posts");
        expect(policy.when).toBe(when);
    });

    it("accepts a relation predicate as a read decision and threads it through verbatim", () => {
        expect.assertions(1);

        // "a user may read posts authored by someone in their org" — a to-one
        // relation predicate the pre-resolver resolves into a flat `authorId IN`.
        const policy = definePolicy<"posts", { orgId: string }>({
            on: "read",
            table: "posts",
            when: ({ ctx }) => {
                return { author: { is: { orgId: ctx.orgId } } };
            },
        });

        expect(policy.when({ auth: { can: () => false, roles: [], userId: null }, ctx: { orgId: "o1" } })).toStrictEqual({
            author: { is: { orgId: "o1" } },
        });
    });

    it("accepts a to-many relation predicate and a flat column predicate", () => {
        expect.assertions(2);

        const someAuthored = definePolicy({
            on: "read",
            table: "users",
            when: () => {
                return { posts: { some: { title: "hello" } } };
            },
        });
        const ownRow = definePolicy<"users", { userId: string }>({
            on: "read",
            table: "users",
            when: ({ ctx }) => {
                return { _id: ctx.userId };
            },
        });

        expect(someAuthored.table).toBe("users");
        expect(ownRow.table).toBe("users");
    });

    it("constrains the decision type to the bound table's relation-aware where", () => {
        expect.assertions(0);

        expectTypeOf(definePolicy<"posts">)
            .parameter(0)
            .toMatchTypeOf<{ on: "delete" | "insert" | "read" | "update"; table: "posts" }>();
    });

    it("rejects an unknown table at compile time", () => {
        expect.assertions(0);

        // @ts-expect-error — "ghosts" is not a table in DataModel.
        definePolicy({ on: "read", table: "ghosts", when: () => true });
    });

    it("rejects a relation predicate naming a relation the table does not declare", () => {
        expect.assertions(0);

        definePolicy({
            on: "read",
            table: "posts",
            // @ts-expect-error — `posts` has no `editor` relation (only `author`).
            when: () => {
                return { editor: { is: { name: "x" } } };
            },
        });
    });
});
