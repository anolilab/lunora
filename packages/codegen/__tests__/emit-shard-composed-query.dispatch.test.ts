/**
 * A query composed with `ctx.runQuery` from a mutation or action, driven through
 * the REAL dispatch (see `emit-shard-deferred-deletes.dispatch.test.ts` for the
 * harness and why it exists).
 *
 * The composed query must behave as it does when called directly or live: no
 * `ctx.origin`, no origin fallback in the storage facade, and a `run*` guard that
 * refuses a mutation — while the calling mutation keeps its own `ctx.origin`.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

interface TestCtx {
    origin?: string;
    runMutation: (reference: { __lunoraRef: string }, args: Record<string, unknown>) => Promise<unknown>;
    runQuery: (reference: { __lunoraRef: string }, args: Record<string, unknown>, options?: { untracked?: boolean }) => Promise<unknown>;
    storage: { getUrl: (key: string) => string };
}

const ORIGIN = "https://chat.example.com";

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

/** A shard whose every dispatch arrived on {@link ORIGIN}, with storage that signs against the origin it was built with. */
const createShard = (): { handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown> } => {
    const ShardClass = createShardDO({
        storage: (_env, origin) => {
            return { getUrl: (key: string) => `${origin ?? "no-origin"}/${key}` };
        },
    });

    const shard = new ShardClass(createState() as never, {});

    // `getCurrentOrigin` is what `/rpc` sets from `x-lunora-origin`; the harness
    // calls `handleRpc` directly, so it is pinned here instead.
    Object.defineProperty(shard, "getCurrentOrigin", { value: () => ORIGIN });

    return shard;
};

const register = (path: string, kind: "action" | "mutation" | "query", handler: (ctx: TestCtx) => unknown): void => {
    (LUNORA_FUNCTIONS as unknown as Record<string, unknown>)[path] = { args: {}, handler, kind };
};

describe("emitted shard — composed ctx.runQuery", () => {
    beforeAll(() => {
        register("composed:sign", "query", (ctx) => {
            return { origin: ctx.origin ?? null, url: ctx.storage.getUrl("a.png") };
        });

        register("composed:noop", "mutation", () => undefined);

        register("composed:tryMutate", "query", async (ctx) => ctx.runMutation({ __lunoraRef: "composed:noop" }, {}));

        register("composed:fromMutation", "mutation", async (ctx) => {
            return {
                own: { origin: ctx.origin ?? null, url: ctx.storage.getUrl("a.png") },
                tracked: await ctx.runQuery({ __lunoraRef: "composed:sign" }, {}),
                untracked: await ctx.runQuery({ __lunoraRef: "composed:sign" }, {}, { untracked: true }),
            };
        });

        register("composed:actionTryMutate", "action", async (ctx) => ctx.runQuery({ __lunoraRef: "composed:tryMutate" }, {}));
    });

    it("gives a query no request origin however it is reached, while the mutation keeps its own", async () => {
        expect.assertions(2);

        const shard = createShard();
        const direct = { origin: null, url: "no-origin/a.png" };

        await expect(shard.handleRpc("composed:sign", {})).resolves.toStrictEqual(direct);
        await expect(shard.handleRpc("composed:fromMutation", {})).resolves.toStrictEqual({
            own: { origin: ORIGIN, url: `${ORIGIN}/a.png` },
            tracked: direct,
            untracked: direct,
        });
    });

    it("refuses a mutation from a query composed by an action", async () => {
        expect.assertions(1);

        await expect(createShard().handleRpc("composed:actionTryMutate", {})).rejects.toThrow("a query may only compose other queries");
    });
});
