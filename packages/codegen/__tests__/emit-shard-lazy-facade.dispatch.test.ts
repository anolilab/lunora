/**
 * `ctx.db.<table>` is bound on first read, driven through the REAL dispatch (see
 * `emit-shard-deferred-deletes.dispatch.test.ts` for the harness).
 *
 * Binding every table's facade up front cost a few dozen closures per table on
 * every dispatch, most of them for tables the handler never touched. The lazy
 * accessor must still hand back one stable facade per ctx, and it must survive
 * the telemetry proxy `instrumentDb` puts in front of the writer when a sink is
 * configured: the getter re-defines the property through that proxy's
 * `defineProperty` trap.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

interface NotesFacade {
    findMany: (args?: Record<string, unknown>) => Promise<{ page: { body: string }[] }>;
    insert: (row: Record<string, unknown>) => Promise<unknown>;
}

interface TestCtx {
    db: Record<string, unknown> & { notes: NotesFacade };
    orm: { query: Record<string, unknown> };
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

const createShard = (withSink: boolean): { handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown> } => {
    const ShardClass = createShardDO(
        withSink
            ? {
                  observability: () => {
                      return {};
                  },
              }
            : {},
    );

    return new ShardClass(createState() as never, {});
};

const register = (path: string, kind: "mutation" | "query", handler: (ctx: TestCtx) => unknown): void => {
    (LUNORA_FUNCTIONS as unknown as Record<string, unknown>)[path] = { args: {}, handler, kind };
};

describe("emitted shard — lazy table facades", () => {
    beforeAll(() => {
        register("lazyFacade:shape", "query", (ctx) => {
            const before = Object.getOwnPropertyDescriptor(ctx.db, "notes");
            const first = ctx.db.notes;

            return {
                boundBeforeRead: before !== undefined && "value" in before,
                enumerable: Object.keys(ctx.db).includes("notes"),
                stable: first === ctx.db.notes && ctx.orm.query["notes"] === first,
                untouchedStillLazy: "get" in (Object.getOwnPropertyDescriptor(ctx.db, "contacts") ?? {}),
            };
        });

        register("lazyFacade:insert", "mutation", async (ctx) => ctx.db.notes.insert({ boardId: "b1", body: "lazy", ownerId: "u1" }));

        register("lazyFacade:list", "query", async (ctx) => {
            const { page } = await ctx.db.notes.findMany();

            return page.map((row) => row.body);
        });
    });

    it("defines each table as an accessor and binds it once, on first read", async () => {
        expect.assertions(1);

        await expect(createShard(false).handleRpc("lazyFacade:shape", {})).resolves.toStrictEqual({
            boundBeforeRead: false,
            enumerable: true,
            stable: true,
            untouchedStillLazy: true,
        });
    });

    it.each([
        ["without", false],
        ["with", true],
    ])("writes and reads through a lazy facade %s a telemetry sink", async (_label, withSink) => {
        expect.assertions(2);

        const shard = createShard(withSink);

        await expect(shard.handleRpc("lazyFacade:insert", {})).resolves.toStrictEqual(expect.any(String));
        await expect(shard.handleRpc("lazyFacade:list", {})).resolves.toStrictEqual(["lazy"]);
    });
});
