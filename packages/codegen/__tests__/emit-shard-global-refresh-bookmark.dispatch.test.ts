/**
 * The refresh a `.global()` write schedules, driven through the REAL emitted `buildCtx` /
 * `executeSubscription` of the `delta-sync` golden (see `emit-shard-identity-dedup.dispatch.test.ts`
 * for the harness shape).
 *
 * The global writer reports each stored row through `onWrite` and the bookmark its session holds
 * through `onBookmark`. The subscription re-run that write schedules must open its global reader at
 * that bookmark, not at the inbound one of whichever dispatch holds the instance when it runs.
 */
import { DatabaseSync } from "node:sqlite";

import { initLunora } from "@lunora/server";
import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";

interface FakeSocket {
    attachment: unknown;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

interface Shard {
    fetch: (request: Request) => Promise<Response>;
    webSocketMessage: (ws: unknown, message: string) => Promise<void>;
}

interface GlobalRequest {
    bookmark?: string;
    onBookmark?: (bookmark: string | undefined) => void;
    onWrite?: (table: string) => void;
}

/** No `waitUntil`, so a write's refresh pass has finished when its `/rpc` resolves. */
const createState = (sockets: FakeSocket[]): unknown => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
        acceptWebSocket: (ws: FakeSocket) => {
            sockets.push(ws);
        },
        getWebSockets: () => sockets,
        id: { name: "shard-a" },
        storage: {
            sql: { exec: run },
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                run("BEGIN");

                try {
                    const result = await closure();

                    run("COMMIT");

                    return result;
                } catch (error) {
                    run("ROLLBACK");

                    throw error;
                }
            },
        },
    };
};

/**
 * A global writer whose `insert` stands in for D1: it reports the bookmark the write left (when given
 * one) and the table it stored, as the generated D1 factory and the sql-store writer do.
 */
const createHarness = (
    writtenBookmark: string | undefined,
    reportsWrites = true,
): { readBookmarks: (string | undefined)[]; shard: Shard; sockets: FakeSocket[] } => {
    const readBookmarks: (string | undefined)[] = [];
    const sockets: FakeSocket[] = [];
    const ShardClass = createShardDO({
        d1: ((_env: unknown, request: GlobalRequest) => {
            return {
                findMany: async () => {
                    readBookmarks.push(request.bookmark);

                    return [];
                },
                insert: async () => {
                    if (writtenBookmark !== undefined) {
                        request.onBookmark?.(writtenBookmark);
                    }

                    if (reportsWrites) {
                        request.onWrite?.("boards");
                    }

                    return "board-1";
                },
            };
        }) as never,
    }) as unknown as new (state: never, env: never) => Shard;
    const shard = new ShardClass(createState(sockets) as never, {} as never);

    return { readBookmarks, shard, sockets };
};

const subscribe = async (shard: Shard, sockets: FakeSocket[]): Promise<FakeSocket> => {
    const ws: FakeSocket = {
        attachment: { subs: {} },
        close: () => undefined,
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value;
        },
    };

    sockets.push(ws);
    await shard.webSocketMessage(ws, JSON.stringify({ id: "sub", query: { args: {}, functionPath: "bookmark:boards" }, type: "subscribe" }));

    return ws;
};

const write = async (shard: Shard, inboundBookmark: string): Promise<void> => {
    const response = await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "bookmark:addBoard" }),
            headers: { "content-type": "application/json", "x-d1-bookmark": inboundBookmark },
            method: "POST",
        }),
    );

    if (!response.ok) {
        throw new Error(`write failed: ${await response.text()}`);
    }
};

describe("emitted shard — the refresh a .global() write schedules", () => {
    beforeAll(() => {
        const lunora = initLunora.dataModel<Record<string, never>>().create() as unknown as {
            mutation: { input: (shape: unknown) => { mutation: (handler: (input: { ctx: never }) => unknown) => unknown } };
            query: { input: (shape: unknown) => { query: (handler: (input: { ctx: never }) => unknown) => unknown } };
        };
        type GlobalCtx = { db: { findMany: (table: string, args?: unknown) => Promise<unknown[]>; insert: (table: string, row: unknown) => Promise<unknown> } };

        Object.assign(LUNORA_FUNCTIONS, {
            "bookmark:addBoard": lunora.mutation
                .input({})
                .mutation(async ({ ctx }) => (ctx as GlobalCtx).db.insert("boards", { name: "board", ownerId: "owner" })),
            "bookmark:boards": lunora.query.input({}).query(async ({ ctx }) => (ctx as GlobalCtx).db.findMany("boards", {})),
        });
    });

    it("reads at the bookmark the write reported, not the writer's inbound one", async () => {
        expect.assertions(1);

        const { readBookmarks, shard, sockets } = createHarness("bookmark-after-write");

        await subscribe(shard, sockets);
        readBookmarks.length = 0;
        await write(shard, "bookmark-before-write");

        expect(readBookmarks).toStrictEqual(["bookmark-after-write"]);
    });

    it("reads at it too when the writer reports no stored rows, from the shard engine's own broadcast", async () => {
        expect.assertions(1);

        // A hand-written `d1` factory that never forwards `onWrite`.
        const { readBookmarks, shard, sockets } = createHarness("bookmark-after-write", false);

        await subscribe(shard, sockets);
        readBookmarks.length = 0;
        await write(shard, "bookmark-before-write");

        expect(readBookmarks).toStrictEqual(["bookmark-after-write"]);
    });

    it("keeps the reader's own choice when the write reported no bookmark", async () => {
        expect.assertions(1);

        const { readBookmarks, shard, sockets } = createHarness(undefined);

        await subscribe(shard, sockets);
        readBookmarks.length = 0;
        await write(shard, "bookmark-before-write");

        expect(readBookmarks).toStrictEqual(["bookmark-before-write"]);
    });
});
