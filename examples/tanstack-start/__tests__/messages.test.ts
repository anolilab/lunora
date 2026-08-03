/**
 * Boots the real schema and procedures against the in-memory harness — the same
 * code the deployed worker runs, with no Durable Object and no wrangler.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, expect, it } from "vitest";

import { board, send } from "../lunora/messages";
import schema from "../lunora/schema";

let t: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    t = lunoraTest(schema);
});

afterEach(() => {
    t.close();
});

it("returns the newest message first, which is what the SSR loader renders", async () => {
    await t.mutation(send, { author: "ada", body: "first" });
    await t.mutation(send, { author: "grace", body: "second" });

    const { messages } = await t.query(board, {});

    expect(messages.map((message) => message.body)).toStrictEqual(["second", "first"]);
});

it("honours the loader's limit", async () => {
    for (const body of ["a", "b", "c"]) {
        await t.mutation(send, { author: "ada", body });
    }

    expect((await t.query(board, { limit: 2 })).messages).toHaveLength(2);
});
