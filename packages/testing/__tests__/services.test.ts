import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";

const { action, mutation } = initLunora.dataModel().create();

const schema = defineSchema({
    documents: defineTable({
        text: v.string(),
    }),
});

/** The slice of a generated action ctx these handlers use; `ctx.services` is codegen-typed in an app. */
type WithServices = { services: { documentParser: { fetch: typeof globalThis.fetch } } };

const parse = action.input({ url: v.string() }).action(async ({ args, ctx }) => {
    const response = await (ctx as unknown as WithServices).services.documentParser.fetch("https://parser/parse", {
        body: JSON.stringify({ url: args.url }),
        method: "POST",
    });

    return (await response.json()) as { text: string };
});

const readServices = mutation.input({}).mutation(async ({ ctx }) => "services" in ctx);

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, options);

    open.push(t);

    return t;
};

describe("injectable ctx.services", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("hands an action the fake passed for a service", async () => {
        expect.assertions(2);

        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ text: "parsed" }));
        const t = start({ services: { documentParser: { fetch } } });

        await expect(t.action(parse, { url: "https://example.test/doc.pdf" })).resolves.toStrictEqual({ text: "parsed" });
        expect(fetch).toHaveBeenCalledWith("https://parser/parse", expect.objectContaining({ method: "POST" }));
    });

    it("keeps the fakes on a withIdentity view", async () => {
        expect.assertions(1);

        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ text: "as user" }));
        const t = start({ services: { documentParser: { fetch } } }).withIdentity({ userId: "u1" });

        await expect(t.action(parse, { url: "https://example.test/doc.pdf" })).resolves.toStrictEqual({ text: "as user" });
    });

    it("throws on a service with no fake, naming the option", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.action(parse, { url: "https://example.test/doc.pdf" })).rejects.toThrow(
            /ctx\.services\.documentParser has no fake .* services: \{ documentParser/u,
        );
    });

    it("gives mutations no ctx.services, as at runtime", async () => {
        expect.assertions(1);

        const t = start({ services: { documentParser: { fetch: vi.fn<typeof globalThis.fetch>() } } });

        await expect(t.mutation(readServices, {})).resolves.toBe(false);
    });
});
