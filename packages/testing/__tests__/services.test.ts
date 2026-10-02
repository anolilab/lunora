import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

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

const harnesses = trackHarnesses();

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, options);

    harnesses.track(t);

    return t;
};

describe("injectable ctx.services", () => {
    afterEach(() => {
        harnesses.closeAll();
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

    it("can be returned, awaited and inspected without reaching for a service", async () => {
        expect.assertions(2);

        const t = start({ services: { documentParser: { fetch: vi.fn<typeof globalThis.fetch>() } } });
        const services = await t.action(async (ctx) => (ctx as unknown as WithServices).services);

        expect(services).toStrictEqual({ documentParser: { fetch: expect.any(Function) } });
        // Inspection and coercion read `Object.prototype` members; they are not services.
        expect(typeof services.toString).toBe("function");
    });

    it("exposes only the keys it was given", async () => {
        expect.assertions(1);

        const t = start({ services: { parser: { fetch: vi.fn<typeof globalThis.fetch>() } } });

        await expect(t.action(parse, { url: "https://example.test/doc.pdf" })).rejects.toThrow(/ctx\.services\.documentParser has no fake/u);
    });

    it("gives mutations no ctx.services, as at runtime", async () => {
        expect.assertions(1);

        const t = start({ services: { documentParser: { fetch: vi.fn<typeof globalThis.fetch>() } } });

        await expect(t.mutation(readServices, {})).resolves.toBe(false);
    });
});
