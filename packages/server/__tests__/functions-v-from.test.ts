/**
 * Integration test: v.from() args validator in query/mutation/action.
 * Tests that mixed v.from() + v.*() args maps validate correctly end-to-end.
 */
import { describe, expect, it, vi } from "vitest";

import type { MutationCtx as MutationContext } from "../src/index";
import { initLunora, v, ValidationError } from "../src/index";

const { mutation } = initLunora.dataModel().create();

// Hand-rolled Standard Schema v1 string fixture (uppercases on success).
const fakeStringSchema = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string"
                ? { value: value.toUpperCase() }
                : { issues: [{ message: "expected string from fakeSchema", path: [] as PropertyKey[] }] },
        vendor: "fake",
        version: 1 as const,
    },
};

const makeMutationContext = (): MutationContext => {
    return {
        auth: { getIdentity: async () => null, userId: null },
        db: {} as MutationContext["db"],
        log: {} as MutationContext["log"],
        metrics: { count: () => undefined, gauge: () => undefined, record: () => undefined },

        trace: (async (_name: string, fn: () => unknown) => fn()) as MutationContext["trace"],
        now: 0,
        runMutation: vi.fn<MutationContext["runMutation"]>() as MutationContext["runMutation"],
        secrets: { get: async () => "secret" },
        runQuery: vi.fn<MutationContext["runQuery"]>() as MutationContext["runQuery"],
        scheduler: {} as MutationContext["scheduler"],
        storage: {} as MutationContext["storage"],
        vectors: {} as MutationContext["vectors"],
        workflows: {} as MutationContext["workflows"],
    };
};

describe("v.from() args-map integration", () => {
    it("(a) valid call reaches handler with the transformed value", async () => {
        expect.assertions(2);

        const send = mutation.input({ count: v.number(), name: v.from(fakeStringSchema) }).mutation(async ({ args }) => {
            return { count: args.count, name: args.name };
        });

        const result = await send.handler(makeMutationContext(), { count: 3, name: "hello" });

        // fakeStringSchema uppercases, so "hello" → "HELLO"
        expect(result).toEqual({ count: 3, name: "HELLO" });
        expect(send.kind).toBe("mutation");
    });

    it("(b) invalid name rejects before handler runs", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: MutationContext, args: unknown) => unknown>();

        const send = mutation.input({ count: v.number(), name: v.from(fakeStringSchema) }).mutation(({ args, ctx }) => handler(ctx, args));

        await expect(async () => send.handler(makeMutationContext(), { count: 1, name: 42 })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });

    it("(c) plain v.* sibling still validates", async () => {
        expect.assertions(1);

        const send = mutation.input({ count: v.number(), name: v.from(fakeStringSchema) }).mutation(async ({ args }) => args.count);

        await expect(async () =>
            send.handler(makeMutationContext(), { count: "not-a-number", name: "hi" } as unknown as { count: number; name: string }),
        ).rejects.toBeInstanceOf(ValidationError);
    });
});
