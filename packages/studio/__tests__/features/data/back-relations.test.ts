import { describe, expect, it } from "vitest";

import { backRelationKey, backRelationsFor } from "../../../src/features/data/back-relations";
import type { ColumnMeta } from "../../../src/lib/admin";

const column = (name: string, ref?: string): ColumnMeta => {
    return { name, optional: false, ref, type: ref === undefined ? "string" : "id" };
};

const SCHEMA: Record<string, ColumnMeta[]> = {
    comments: [column("id"), column("authorId", "users"), column("messageId", "messages")],
    messages: [column("id"), column("authorId", "users")],
    users: [column("id"), column("managerId", "users")],
};

describe("backRelationsFor", () => {
    it("finds every table pointing at the given one", () => {
        expect.assertions(1);

        // Two tables reference `users` via `authorId`, plus the self-reference.
        expect(backRelationsFor("users", SCHEMA).map((relation) => backRelationKey(relation))).toStrictEqual([
            "comments.authorId",
            "messages.authorId",
            "users.managerId",
        ]);
    });

    it("includes a self-reference — a tree table's child count is the point", () => {
        expect.assertions(1);

        expect(backRelationsFor("users", SCHEMA)).toContainEqual({ column: "managerId", table: "users" });
    });

    it("matches on the ref TARGET, not on column naming", () => {
        expect.assertions(2);

        // `messages.authorId` points at users, so it is a reverse edge of `users`
        // — and NOT of `messages`, despite living there.
        expect(backRelationsFor("messages", SCHEMA).map((relation) => backRelationKey(relation))).toStrictEqual(["comments.messageId"]);
        expect(backRelationsFor("messages", SCHEMA)).not.toContainEqual({ column: "authorId", table: "messages" });
    });

    it("returns nothing for a table nobody references", () => {
        expect.assertions(1);

        expect(backRelationsFor("comments", SCHEMA)).toStrictEqual([]);
    });

    it("orders stably so the columns menu does not reshuffle between loads", () => {
        expect.assertions(1);

        const reversed = Object.fromEntries(Object.entries(SCHEMA).toReversed());

        expect(backRelationsFor("users", reversed).map((relation) => backRelationKey(relation))).toStrictEqual(
            backRelationsFor("users", SCHEMA).map((relation) => backRelationKey(relation)),
        );
    });
});
