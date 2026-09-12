/**
 * Does the example actually work?
 *
 * This boots the real schema and the real procedures against the in-memory
 * harness — same code the deployed worker runs, no Durable Object, no wrangler.
 * It is the check that catches the failures unit tests on `ordering.ts` cannot:
 * a column dropped by codegen, an index that does not match its query, a
 * middleware whose table was never created.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../lunora/schema";
import { create, list, move, remove, rename } from "../lunora/tasks";

let t: ReturnType<typeof lunoraTest>;

describe("board", () => {
    beforeEach(() => {
        t = lunoraTest(schema);
    });

    afterEach(() => {
        t.close();
    });

    const titles = async (status: string) => {
        const tasks = await t.query(list, {});

        return tasks.filter((task) => task.status === status).map((task) => task.title);
    };

    it("creates cards in the column they were added to, in insertion order", async () => {
        expect.assertions(2);

        await t.mutation(create, { title: "first" });
        await t.mutation(create, { title: "second" });
        await t.mutation(create, { status: "done", title: "shipped" });

        await expect(titles("todo")).resolves.toStrictEqual(["first", "second"]);
        await expect(titles("done")).resolves.toStrictEqual(["shipped"]);
    });

    it("moves a card across columns and lands it at the requested index", async () => {
        expect.assertions(3);

        await t.mutation(create, { title: "a" });
        await t.mutation(create, { title: "b" });
        await t.mutation(create, { title: "c" });

        const board = await t.query(list, {});
        const c = board.find((task) => task.title === "c");

        expect(c).toBeDefined();

        await t.mutation(move, { id: c!._id, index: 1, status: "in-progress" });

        await expect(titles("todo")).resolves.toStrictEqual(["a", "b"]);
        await expect(titles("in-progress")).resolves.toStrictEqual(["c"]);
    });

    it("reorders within a column without touching its neighbours' keys", async () => {
        expect.assertions(2);

        await t.mutation(create, { title: "a" });
        await t.mutation(create, { title: "b" });
        await t.mutation(create, { title: "c" });

        const before = await t.query(list, {});
        const c = before.find((task) => task.title === "c")!;

        // Drop "c" at the head. Only its own row may be rewritten — that is the
        // point of the fractional index.
        await t.mutation(move, { id: c._id, index: 0, status: "todo" });

        await expect(titles("todo")).resolves.toStrictEqual(["c", "a", "b"]);

        const after = await t.query(list, {});
        const unchanged = ["a", "b"].every((title) => after.find((task) => task.title === title)?.order === before.find((task) => task.title === title)?.order);

        expect(unchanged).toBe(true);
    });

    it("renames and deletes", async () => {
        expect.assertions(2);

        const id = await t.mutation(create, { title: "typo" });

        await t.mutation(rename, { id, title: "fixed" });

        await expect(titles("todo")).resolves.toStrictEqual(["fixed"]);

        await t.mutation(remove, { id });

        await expect(t.query(list, {})).resolves.toStrictEqual([]);
    });

    it("ignores a move for a card that no longer exists", async () => {
        expect.assertions(1);

        const id = await t.mutation(create, { title: "gone" });

        await t.mutation(remove, { id });

        await expect(t.mutation(move, { id, index: 0, status: "done" })).resolves.toBeUndefined();
    });
});
