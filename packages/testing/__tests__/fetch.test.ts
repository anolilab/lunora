import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";

const { action } = initLunora.dataModel().create();

const schema = defineSchema({
    pings: defineTable({
        url: v.string(),
    }),
});

/** Action that calls ctx.fetch and stores the response status. */
const ping = action.input({ url: v.string() }).action(async ({ args, ctx }) => {
    const response = await ctx.fetch(args.url);

    return { status: response.status };
});

/**
 * Action that calls ctx.fetch — used with a harness that has NO fetch injected
 * to confirm the stub still throws.
 */
const pingNoInject = action.input({ url: v.string() }).action(async ({ args, ctx }) => {
    const response = await ctx.fetch(args.url);

    return { status: response.status };
});

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, options);

    open.push(t);

    return t;
};

describe("injectable action fetch", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("uses the injected fetch when provided and action calls ctx.fetch", async () => {
        expect.assertions(2);

        const fakeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));

        const t = start({ fetch: fakeFetch as unknown as typeof globalThis.fetch });

        const result = await t.action(ping, { url: "https://example.test/ping" });

        expect(result.status).toBe(200);
        expect(fakeFetch).toHaveBeenCalledWith("https://example.test/ping");
    });

    it("throws the v1 stub error when no fetch is injected", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.action(pingNoInject, { url: "https://example.test/ping" })).rejects.toThrow(
            "ctx.fetch is not available in the in-memory @lunora/testing harness (v1)",
        );
    });

    it("injected fetch is available inside withIdentity views", async () => {
        expect.assertions(1);

        const fakeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));

        const t = start({ fetch: fakeFetch as unknown as typeof globalThis.fetch }).withIdentity({ userId: "u1" });

        const result = await t.action(ping, { url: "https://example.test/no-content" });

        expect(result.status).toBe(204);
    });

    it("inline action can use the injected fetch", async () => {
        expect.assertions(1);

        const fakeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: 42 }, { status: 200 }));

        const t = start({ fetch: fakeFetch as unknown as typeof globalThis.fetch });

        const status = await t.action(async (ctx) => {
            const response = await ctx.fetch("https://example.test/inline");

            return response.status;
        });

        expect(status).toBe(200);
    });
});
