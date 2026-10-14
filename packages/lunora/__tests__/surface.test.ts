import { describe, expect, it } from "vitest";

// Key-parity with upstream is covered by re-exports.test.ts; these tests pin
// the load-bearing names an app actually imports from the umbrella — the ones
// codegen emits and the docs teach — and prove the wiring works end-to-end,
// not just that some keys exist.

describe("lunorash default entry (server authoring API)", () => {
    it("exposes the schema + procedure authoring surface", async () => {
        expect.assertions(5);

        const lunorash: Record<string, unknown> = await import("lunorash");

        expect(typeof lunorash.defineSchema).toBe("function");
        expect(typeof lunorash.defineTable).toBe("function");
        expect(typeof lunorash.v).toBe("object");
        expect(typeof lunorash.LunoraError).toBe("function");
        expect(lunorash.initLunora).toBeDefined();
    });

    it("builds a working schema through the umbrella", async () => {
        expect.assertions(1);

        const { defineSchema, defineTable, v } = (await import("lunorash")) as unknown as {
            defineSchema: (tables: Record<string, unknown>) => { tables: Record<string, unknown> };
            defineTable: (fields: Record<string, unknown>) => unknown;
            v: { string: () => unknown };
        };

        const schema = defineSchema({ messages: defineTable({ body: v.string() }) });

        expect(Object.keys(schema.tables)).toStrictEqual(["messages"]);
    });

    it("mints the query/mutation/action procedure builders via initLunora", async () => {
        expect.assertions(19);

        const { initLunora } = (await import("lunorash")) as unknown as {
            initLunora: { dataModel: () => { create: () => Record<string, { __lunoraProcedure: string; input: unknown; use: unknown }> } };
        };

        const builders = initLunora.dataModel().create();

        expect(Object.keys(builders).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "action",
            "internalAction",
            "internalMutation",
            "internalQuery",
            "mutation",
            "query",
        ]);

        // Each builder is a chainable procedure entry marked with its kind —
        // exactly what codegen-generated `_generated/server` re-exports.
        for (const [kind, builder] of Object.entries(builders)) {
            expect(builder.__lunoraProcedure, `${kind} carries the wrong procedure marker`).toBe(kind.replace("internal", "").toLowerCase());
            expect(typeof builder.input, `${kind}.input is not chainable`).toBe("function");
            expect(typeof builder.use, `${kind}.use is not chainable`).toBe("function");
        }
    });
});

describe("lunorash subpath load-bearing names", () => {
    it("lunorash/values ships the v validator namespace", async () => {
        expect.assertions(3);

        const { v } = (await import("lunorash/values")) as unknown as { v: Record<string, unknown> };

        expect(typeof v.string).toBe("function");
        expect(typeof v.object).toBe("function");
        expect(typeof v.id).toBe("function");
    });

    it("lunorash/client ships LunoraClient (what codegen's FunctionReference client uses)", async () => {
        expect.assertions(2);

        const client: Record<string, unknown> = await import("lunorash/client");

        expect(typeof client.LunoraClient).toBe("function");
        expect(typeof client.createLocalStore).toBe("function");
    });

    it("lunorash/runtime ships the worker entry factories", async () => {
        expect.assertions(3);

        const runtime: Record<string, unknown> = await import("lunorash/runtime");

        expect(typeof runtime.createWorker).toBe("function");
        expect(typeof runtime.composeWorker).toBe("function");
        expect(typeof runtime.createLunoraHandler).toBe("function");
    });

    it("lunorash/do ships the Durable Object classes wrangler binds", async () => {
        expect.assertions(3);

        const doModule: Record<string, unknown> = await import("lunorash/do");

        expect(typeof doModule.ShardDO).toBe("function");
        expect(typeof doModule.SessionDO).toBe("function");
        expect(typeof doModule.ShardRegistryDO).toBe("function");
    });

    it("lunorash/errors forwards a working unified error layer", async () => {
        expect.assertions(4);

        const { LunoraError, toErrorBody } = (await import("lunorash/errors")) as unknown as {
            LunoraError: new (code: string, message?: string) => Error;
            toErrorBody: (error: unknown) => { body: { code: string; message: string }; redacted: boolean; status: number };
        };

        // Not just names: the redaction seam behaves through the umbrella.
        const echoed = toErrorBody(new LunoraError("NOT_FOUND", "row gone"));

        expect(echoed.status).toBe(404);
        expect(echoed.body.message).toBe("row gone");

        const redacted = toErrorBody(new LunoraError("INTERNAL", "sql detail"));

        expect(redacted.redacted).toBe(true);
        expect(redacted.body.message).not.toContain("sql detail");
    });

    it("lunorash/flags ships defineFlags and each provider under its flattened alias", async () => {
        expect.assertions(4);

        const flags: Record<string, unknown> = await import("lunorash/flags");
        const { memoryProvider } = (await import("lunorash/flags/memory")) as unknown as { memoryProvider: (flags: Record<string, unknown>) => unknown };
        const { envProvider } = (await import("lunorash/flags/env")) as unknown as { envProvider: unknown };
        const { flagshipProvider } = (await import("lunorash/flags/flagship")) as unknown as { flagshipProvider: unknown };

        expect(typeof flags.defineFlags).toBe("function");
        expect(typeof memoryProvider).toBe("function");
        expect(typeof envProvider).toBe("function");
        expect(typeof flagshipProvider).toBe("function");
    });

    it("lunorash/ratelimit ships the limiter surface", async () => {
        expect.assertions(3);

        const ratelimit: Record<string, unknown> = await import("lunorash/ratelimit");

        expect(typeof ratelimit.rateLimit).toBe("function");
        expect(typeof ratelimit.RateLimiter).toBe("function");
        expect(typeof ratelimit.createMemoryStore).toBe("function");
    });
});
