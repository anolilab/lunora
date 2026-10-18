/**
 * `ctx.fetch` is action-only, driven through the REAL dispatch.
 *
 * A query is re-run by every live subscription and a mutation may be replayed, so
 * a network call in either must fail loudly rather than return a different answer
 * each run. The refusal is a runtime throw on the ctx the dispatch builds, so it
 * holds for call sites no lint can read. An action keeps the real fetch, and a
 * query composed from an action gets the refusal too.
 */
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

interface TestCtx {
    fetch: (input: string) => Promise<Response>;
    runQuery: (reference: { __lunoraRef: string }, args: Record<string, unknown>) => Promise<unknown>;
}

const createState = (): unknown => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        id: { name: "shard-a" },
        storage: { sql: { exec: run } },
    };
};

const createShard = (): { handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown> } => {
    const ShardClass = createShardDO({});

    return new ShardClass(createState() as never, {});
};

const register = (path: string, kind: "action" | "mutation" | "query", handler: (ctx: TestCtx) => unknown): void => {
    (LUNORA_FUNCTIONS as unknown as Record<string, unknown>)[path] = { args: {}, handler, kind };
};

describe("emitted shard — ctx.fetch is action-only", () => {
    beforeAll(() => {
        register("fetchRefusal:query", "query", async (ctx) => ctx.fetch("https://example.com/q"));

        register("fetchRefusal:mutation", "mutation", async (ctx) => ctx.fetch("https://example.com/m"));

        register("fetchRefusal:unawaited", "mutation", (ctx) => {
            // Deliberately not awaited: a refusal that only rejected this promise would let the handler return "done".
            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the discarded promise is the case under test
            ctx.fetch("https://example.com/u");

            return "done";
        });

        register("fetchRefusal:action", "action", async (ctx) => {
            const response = await ctx.fetch("https://example.com/a");

            return response.text();
        });

        register("fetchRefusal:actionRunsQuery", "action", async (ctx) => ctx.runQuery({ __lunoraRef: "fetchRefusal:query" }, {}));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses a query's fetch", async () => {
        expect.assertions(1);

        await expect(createShard().handleRpc("fetchRefusal:query", {})).rejects.toThrow("ctx.fetch is action-only");
    });

    it("refuses a mutation's fetch", async () => {
        expect.assertions(1);

        await expect(createShard().handleRpc("fetchRefusal:mutation", {})).rejects.toThrow("ctx.fetch is action-only");
    });

    it("refuses a fetch the handler discards without awaiting", async () => {
        expect.assertions(1);

        await expect(createShard().handleRpc("fetchRefusal:unawaited", {})).rejects.toThrow("ctx.fetch is action-only");
    });

    it("keeps the real fetch in an action", async () => {
        expect.assertions(2);

        const fetchStub = vi.fn<typeof fetch>(async () => new Response("upstream"));

        vi.stubGlobal("fetch", fetchStub);

        await expect(createShard().handleRpc("fetchRefusal:action", {})).resolves.toBe("upstream");
        expect(fetchStub).toHaveBeenCalledWith("https://example.com/a", undefined);
    });

    it("refuses the fetch of a query an action composes", async () => {
        expect.assertions(1);

        await expect(createShard().handleRpc("fetchRefusal:actionRunsQuery", {})).rejects.toThrow("ctx.fetch is action-only");
    });
});
