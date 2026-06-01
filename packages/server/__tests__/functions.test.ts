import { describe, expect, test, vi } from "vitest";

import type { ActionCtx, MutationCtx, QueryCtx } from "../src/index.js";
import { action, internalAction, internalMutation, internalQuery, mutation, query, v, ValidationError } from "../src/index.js";

const makeQueryCtx = (): QueryCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as QueryCtx["db"],
    storage: {} as QueryCtx["storage"],
    vectors: {} as QueryCtx["vectors"],
});

const makeMutationCtx = (): MutationCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as MutationCtx["db"],
    scheduler: {} as MutationCtx["scheduler"],
    storage: {} as MutationCtx["storage"],
    vectors: {} as MutationCtx["vectors"],
});

const makeActionCtx = (): ActionCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as ActionCtx["db"],
    fetch: globalThis.fetch,
    runAction: vi.fn<ActionCtx["runAction"]>() as ActionCtx["runAction"],
    runMutation: vi.fn<ActionCtx["runMutation"]>() as ActionCtx["runMutation"],
    runQuery: vi.fn<ActionCtx["runQuery"]>() as ActionCtx["runQuery"],
    scheduler: {} as ActionCtx["scheduler"],
    storage: {} as ActionCtx["storage"],
    vectors: {} as ActionCtx["vectors"],
});

describe("query", () => {
    test("preserves args validator and runs handler with parsed args", async () => {
        expect.assertions(4);

        const handler = vi.fn<(context: QueryCtx, args: { limit: number }) => Promise<number>>(
            async (_context: QueryCtx, args: { limit: number }) => args.limit * 2,
        );

        const list = query({
            args: { limit: v.number() },
            handler,
        });

        expect(list.kind).toBe("query");
        expect(list.args.limit.kind).toBe("number");

        const result = await list.handler(makeQueryCtx(), { limit: 5 });

        expect(result).toBe(10);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test("throws ValidationError before handler runs on bad args", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { limit: number }) => unknown>();

        const list = query({
            args: { limit: v.number() },
            handler,
        });

        await expect(async () => list.handler(makeQueryCtx(), { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("mutation", () => {
    test("validates and runs", async () => {
        expect.assertions(2);

        const send = mutation({
            args: { text: v.string() },
            handler: async (_context, args) => ({ ok: true, text: args.text }),
        });

        expect(send.kind).toBe("mutation");
        await expect(send.handler(makeMutationCtx(), { text: "hi" })).resolves.toEqual({ ok: true, text: "hi" });
    });

    test("optional args may be omitted", async () => {
        expect.assertions(1);

        const send = mutation({
            args: { tag: v.optional(v.string()), text: v.string() },
            handler: async (_context, args) => args.tag ?? "untagged",
        });

        await expect(send.handler(makeMutationCtx(), { text: "hi" })).resolves.toBe("untagged");
    });
});

describe("action", () => {
    test("validates and runs", async () => {
        expect.assertions(2);

        const ping = action({
            args: { url: v.string() },
            handler: async (_context, args) => args.url,
        });

        expect(ping.kind).toBe("action");
        await expect(ping.handler(makeActionCtx(), { url: "https://x" })).resolves.toBe("https://x");
    });

    test("bad args bubble up before handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { url: string }) => unknown>();
        const ping = action({ args: { url: v.string() }, handler });

        await expect(async () => ping.handler(makeActionCtx(), { url: 42 } as unknown as { url: string })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("visibility", () => {
    test("public factories omit the visibility key (absence === public)", () => {
        expect.assertions(3);

        expect(query({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
        expect(mutation({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
        expect(action({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
    });

    test("internal factories stamp visibility: internal while keeping the right kind", () => {
        expect.assertions(3);

        const stats = internalQuery({ args: {}, handler: () => null });
        const purge = internalMutation({ args: {}, handler: () => null });
        const sync = internalAction({ args: {}, handler: () => null });

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });
        expect(purge).toMatchObject({ kind: "mutation", visibility: "internal" });
        expect(sync).toMatchObject({ kind: "action", visibility: "internal" });
    });

    test("internal factories still validate and run their handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: MutationCtx, args: { text: string }) => Promise<string>>(
            async (_context: MutationCtx, args: { text: string }) => args.text,
        );
        const purge = internalMutation({ args: { text: v.string() }, handler });

        await expect(purge.handler(makeMutationCtx(), { text: "hi" })).resolves.toBe("hi");
        await expect(async () => purge.handler(makeMutationCtx(), { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });
});
