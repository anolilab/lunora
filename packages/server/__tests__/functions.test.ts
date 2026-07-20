import { describe, expect, it, vi } from "vitest";

import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../src/index";
import { initLunora, v, ValidationError } from "../src/index";

const { action, internalAction, internalMutation, internalQuery, mutation, query } = initLunora.dataModel().create();

const makeQueryContext = (): QueryContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        secrets: { get: async () => "secret" },
        db: {} as QueryContext["db"],
        log: {} as QueryContext["log"],
        metrics: { count: () => undefined, gauge: () => undefined, record: () => undefined },
        now: 0,
        runQuery: vi.fn<QueryContext["runQuery"]>() as QueryContext["runQuery"],
        storage: {} as QueryContext["storage"],
        trace: (async (_name: string, fn: (t: unknown) => unknown) => fn(undefined)) as QueryContext["trace"],
        vectors: {} as QueryContext["vectors"],
    };
};

const makeMutationContext = (): MutationContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        secrets: { get: async () => "secret" },
        db: {} as MutationContext["db"],
        log: {} as MutationContext["log"],
        metrics: { count: () => undefined, gauge: () => undefined, record: () => undefined },
        now: 0,
        runMutation: vi.fn<MutationContext["runMutation"]>() as MutationContext["runMutation"],
        runQuery: vi.fn<MutationContext["runQuery"]>() as MutationContext["runQuery"],
        scheduler: {} as MutationContext["scheduler"],
        storage: {} as MutationContext["storage"],
        trace: (async (_name: string, fn: (t: unknown) => unknown) => fn(undefined)) as MutationContext["trace"],
        vectors: {} as MutationContext["vectors"],
        workflows: {} as MutationContext["workflows"],
    };
};

const makeActionContext = (): ActionContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        cache: { purge: async () => undefined },
        secrets: { get: async () => "secret" },
        db: {} as ActionContext["db"],
        fetch: globalThis.fetch,
        log: {} as ActionContext["log"],
        metrics: { count: () => undefined, gauge: () => undefined, record: () => undefined },
        now: 0,
        runAction: vi.fn<ActionContext["runAction"]>() as ActionContext["runAction"],
        runMutation: vi.fn<ActionContext["runMutation"]>() as ActionContext["runMutation"],
        runQuery: vi.fn<ActionContext["runQuery"]>() as ActionContext["runQuery"],
        scheduler: {} as ActionContext["scheduler"],
        storage: {} as ActionContext["storage"],
        trace: (async (_name: string, fn: (t: unknown) => unknown) => fn(undefined)) as ActionContext["trace"],
        vectors: {} as ActionContext["vectors"],
        workflows: {} as ActionContext["workflows"],
    };
};

describe("query", () => {
    it("preserves args validator and runs handler with parsed args", async () => {
        expect.assertions(4);

        const handler = vi.fn<(context: QueryContext, args: { limit: number }) => Promise<number>>(
            async (_context: QueryContext, args: { limit: number }) => args.limit * 2,
        );

        const list = query.input({ limit: v.number() }).query(async ({ args, ctx }) => handler(ctx, args));

        expect(list.kind).toBe("query");
        expect(list.args.limit.kind).toBe("number");

        const result = await list.handler(makeQueryContext(), { limit: 5 });

        expect(result).toBe(10);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("throws ValidationError before handler runs on bad args", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { limit: number }) => unknown>();

        const list = query.input({ limit: v.number() }).query(({ args, ctx }) => handler(ctx, args));

        await expect(async () => list.handler(makeQueryContext(), { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("mutation", () => {
    it("validates and runs", async () => {
        expect.assertions(2);

        const send = mutation.input({ text: v.string() }).mutation(async ({ args }) => {
            return { ok: true, text: args.text };
        });

        expect(send.kind).toBe("mutation");
        await expect(send.handler(makeMutationContext(), { text: "hi" })).resolves.toEqual({ ok: true, text: "hi" });
    });

    it("optional args may be omitted", async () => {
        expect.assertions(1);

        const send = mutation.input({ tag: v.optional(v.string()), text: v.string() }).mutation(async ({ args }) => args.tag ?? "untagged");

        await expect(send.handler(makeMutationContext(), { text: "hi" })).resolves.toBe("untagged");
    });
});

describe("action", () => {
    it("validates and runs", async () => {
        expect.assertions(2);

        const ping = action.input({ url: v.string() }).action(async ({ args }) => args.url);

        expect(ping.kind).toBe("action");
        await expect(ping.handler(makeActionContext(), { url: "https://x" })).resolves.toBe("https://x");
    });

    it("bad args bubble up before handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: unknown, args: { url: string }) => unknown>();
        const ping = action.input({ url: v.string() }).action(({ args, ctx }) => handler(ctx, args));

        await expect(async () => ping.handler(makeActionContext(), { url: 42 } as unknown as { url: string })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("visibility", () => {
    it("public factories omit the visibility key (absence === public)", () => {
        expect.assertions(3);

        expect(query.query(() => null)).not.toHaveProperty("visibility");
        expect(mutation.mutation(() => null)).not.toHaveProperty("visibility");
        expect(action.action(() => null)).not.toHaveProperty("visibility");
    });

    it("internal factories stamp visibility: internal while keeping the right kind", () => {
        expect.assertions(3);

        const stats = internalQuery.query(() => null);
        const purge = internalMutation.mutation(() => null);
        const sync = internalAction.action(() => null);

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });
        expect(purge).toMatchObject({ kind: "mutation", visibility: "internal" });
        expect(sync).toMatchObject({ kind: "action", visibility: "internal" });
    });

    it("internal factories still validate and run their handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: MutationContext, args: { text: string }) => Promise<string>>(
            async (_context: MutationContext, args: { text: string }) => args.text,
        );
        const purge = internalMutation.input({ text: v.string() }).mutation(({ args, ctx }) => handler(ctx, args));

        await expect(purge.handler(makeMutationContext(), { text: "hi" })).resolves.toBe("hi");
        await expect(async () => purge.handler(makeMutationContext(), { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });
});
