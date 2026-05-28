import { describe, expect, test, vi } from "vitest";

import type { ActionCtx, MutationCtx, QueryCtx } from "../src/index.js";
import { action, mutation, query, v, ValidationError } from "../src/index.js";

const makeQueryCtx = (): QueryCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as QueryCtx["db"],
    storage: {} as QueryCtx["storage"],
});

const makeMutationCtx = (): MutationCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as MutationCtx["db"],
    scheduler: {} as MutationCtx["scheduler"],
    storage: {} as MutationCtx["storage"],
});

const makeActionCtx = (): ActionCtx => ({
    auth: { getIdentity: async () => null, userId: null },
    db: {} as ActionCtx["db"],
    fetch: globalThis.fetch,
    runAction: vi.fn(),
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    scheduler: {} as ActionCtx["scheduler"],
    storage: {} as ActionCtx["storage"],
});

describe("query", () => {
    test("preserves args validator and runs handler with parsed args", async () => {
        const handler = vi.fn(async (_context: QueryCtx, args: { limit: number }) => args.limit * 2);

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
        const handler = vi.fn();

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
        const send = mutation({
            args: { text: v.string() },
            handler: async (_context, args) => ({ ok: true, text: args.text }),
        });

        expect(send.kind).toBe("mutation");
        await expect(send.handler(makeMutationCtx(), { text: "hi" })).resolves.toEqual({ ok: true, text: "hi" });
    });

    test("optional args may be omitted", async () => {
        const send = mutation({
            args: { tag: v.optional(v.string()), text: v.string() },
            handler: async (_context, args) => args.tag ?? "untagged",
        });

        await expect(send.handler(makeMutationCtx(), { text: "hi" })).resolves.toBe("untagged");
    });
});

describe("action", () => {
    test("validates and runs", async () => {
        const ping = action({
            args: { url: v.string() },
            handler: async (_context, args) => args.url,
        });

        expect(ping.kind).toBe("action");
        await expect(ping.handler(makeActionCtx(), { url: "https://x" })).resolves.toBe("https://x");
    });

    test("bad args bubble up before handler", async () => {
        const handler = vi.fn();
        const ping = action({ args: { url: v.string() }, handler });

        await expect(async () => ping.handler(makeActionCtx(), { url: 42 } as unknown as { url: string })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});
