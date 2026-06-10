import { describe, expect, it, vi } from "vitest";

import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../src/index";
import { action, internalAction, internalMutation, internalQuery, mutation, query, v, ValidationError } from "../src/index";

const makeQueryContext = (): QueryContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        db: {} as QueryContext["db"],
        log: {} as QueryContext["log"],
        runQuery: vi.fn<QueryContext["runQuery"]>() as QueryContext["runQuery"],
        storage: {} as QueryContext["storage"],
        vectors: {} as QueryContext["vectors"],
    };
};

const makeMutationContext = (): MutationContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        db: {} as MutationContext["db"],
        log: {} as MutationContext["log"],
        runMutation: vi.fn<MutationContext["runMutation"]>() as MutationContext["runMutation"],
        runQuery: vi.fn<MutationContext["runQuery"]>() as MutationContext["runQuery"],
        scheduler: {} as MutationContext["scheduler"],
        storage: {} as MutationContext["storage"],
        vectors: {} as MutationContext["vectors"],
    };
};

const makeActionContext = (): ActionContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        db: {} as ActionContext["db"],
        fetch: globalThis.fetch,
        log: {} as ActionContext["log"],
        runAction: vi.fn<ActionContext["runAction"]>() as ActionContext["runAction"],
        runMutation: vi.fn<ActionContext["runMutation"]>() as ActionContext["runMutation"],
        runQuery: vi.fn<ActionContext["runQuery"]>() as ActionContext["runQuery"],
        scheduler: {} as ActionContext["scheduler"],
        storage: {} as ActionContext["storage"],
        vectors: {} as ActionContext["vectors"],
    };
};

describe("query", () => {
    it("preserves args validator and runs handler with parsed args", async () => {
        expect.assertions(4);

        const handler = vi.fn<(context: QueryContext, args: { limit: number }) => Promise<number>>(
            async (_context: QueryContext, args: { limit: number }) => args.limit * 2,
        );

        const list = query({
            args: { limit: v.number() },
            handler,
        });

        expect(list.kind).toBe("query");
        expect(list.args.limit.kind).toBe("number");

        const result = await list.handler(makeQueryContext(), { limit: 5 });

        expect(result).toBe(10);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("throws ValidationError before handler runs on bad args", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { limit: number }) => unknown>();

        const list = query({
            args: { limit: v.number() },
            handler,
        });

        await expect(async () => list.handler(makeQueryContext(), { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("mutation", () => {
    it("validates and runs", async () => {
        expect.assertions(2);

        const send = mutation({
            args: { text: v.string() },
            handler: async (_context, args) => {
                return { ok: true, text: args.text };
            },
        });

        expect(send.kind).toBe("mutation");
        await expect(send.handler(makeMutationContext(), { text: "hi" })).resolves.toEqual({ ok: true, text: "hi" });
    });

    it("optional args may be omitted", async () => {
        expect.assertions(1);

        const send = mutation({
            args: { tag: v.optional(v.string()), text: v.string() },
            handler: async (_context, args) => args.tag ?? "untagged",
        });

        await expect(send.handler(makeMutationContext(), { text: "hi" })).resolves.toBe("untagged");
    });
});

describe("action", () => {
    it("validates and runs", async () => {
        expect.assertions(2);

        const ping = action({
            args: { url: v.string() },
            handler: async (_context, args) => args.url,
        });

        expect(ping.kind).toBe("action");
        await expect(ping.handler(makeActionContext(), { url: "https://x" })).resolves.toBe("https://x");
    });

    it("bad args bubble up before handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { url: string }) => unknown>();
        const ping = action({ args: { url: v.string() }, handler });

        await expect(async () => ping.handler(makeActionContext(), { url: 42 } as unknown as { url: string })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("visibility", () => {
    it("public factories omit the visibility key (absence === public)", () => {
        expect.assertions(3);

        expect(query({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
        expect(mutation({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
        expect(action({ args: {}, handler: () => null })).not.toHaveProperty("visibility");
    });

    it("internal factories stamp visibility: internal while keeping the right kind", () => {
        expect.assertions(3);

        const stats = internalQuery({ args: {}, handler: () => null });
        const purge = internalMutation({ args: {}, handler: () => null });
        const sync = internalAction({ args: {}, handler: () => null });

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });
        expect(purge).toMatchObject({ kind: "mutation", visibility: "internal" });
        expect(sync).toMatchObject({ kind: "action", visibility: "internal" });
    });

    it("internal factories still validate and run their handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: MutationContext, args: { text: string }) => Promise<string>>(
            async (_context: MutationContext, args: { text: string }) => args.text,
        );
        const purge = internalMutation({ args: { text: v.string() }, handler });

        await expect(purge.handler(makeMutationContext(), { text: "hi" })).resolves.toBe("hi");
        await expect(async () => purge.handler(makeMutationContext(), { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });
});
