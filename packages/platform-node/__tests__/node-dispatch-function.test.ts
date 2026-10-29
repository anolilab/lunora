import { ShardDO } from "@lunora/do";
import type { MessageBatchLike, MessageLike } from "@lunora/queue";
import { defineQueue, dispatchQueueBatch } from "@lunora/queue";
import { describe, expect, it, vi } from "vitest";

import type { NodePlatform } from "../src/node-platform";
import { createNodePlatform } from "../src/node-platform";
import type { NodeShard } from "../src/node-shard-registry";
import { createNodeShardState } from "../src/node-shard-state";

const TOKEN = "admin-token-for-tests";
const ORIGIN = "https://node.local";

/**
 * A real `ShardDO` serving a real function over the Node shard. The class is
 * the same one `@lunora/do` exports; only `handleRpc` is stubbed, which is the
 * one member codegen emits per app. `notes:add` writes a row into the shard's
 * SQLite, so a passing assertion means the function ran and committed.
 */
class NotesShardDO extends ShardDO {
    private readonly notesShard: NodeShard;

    public constructor(state: never, env: object, notesShard: NodeShard) {
        super(state, env);
        this.notesShard = notesShard;
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        if (functionPath !== "notes:add") {
            return Promise.reject(new Error(`unexpected function ${functionPath}`));
        }

        this.notesShard.shard.sql.exec("CREATE TABLE IF NOT EXISTS notes (value INTEGER)");
        this.notesShard.shard.sql.exec("INSERT INTO notes (value) VALUES (?)", args["value"]);

        return Promise.resolve({ ok: true });
    }
}

const message = <Body>(body: Body): MessageLike<Body> & { acked: boolean } => {
    const m = {
        ack: vi.fn<() => void>(() => {
            m.acked = true;
        }),
        acked: false,
        attempts: 1,
        body,
        id: "m1",
        retry: vi.fn<() => void>(),
        timestamp: new Date(0),
    };

    return m;
};

const batch = <Body>(queue: string, messages: MessageLike<Body>[]): MessageBatchLike<Body> => {
    return {
        ackAll: vi.fn<() => void>(),
        messages,
        queue,
        retryAll: vi.fn<() => void>(),
    };
};

describe("queue handler to dispatch route to shard, in process", () => {
    it("runs a function the handler calls with ctx.run and the row lands in the shard", async () => {
        expect.assertions(3);

        const shards = new Map<string, NodeShard>();
        const shardDos = new Map<string, NotesShardDO>();

        const platform = createNodePlatform({
            dispatch: { adminToken: TOKEN },
            onFetch: async (request, shard) => {
                shards.set(shard.shardKey, shard);

                let shardDo = shardDos.get(shard.shardKey);

                if (shardDo === undefined) {
                    shardDo = new NotesShardDO(createNodeShardState(shard) as never, {}, shard);
                    shardDos.set(shard.shardKey, shardDo);
                }

                return shardDo.fetch(request);
            },
        });

        try {
            const queue = defineQueue({
                handler: async (context, b) => {
                    await Promise.all(
                        b.messages.map(async (m) => {
                            await context.run({ __lunoraRef: "notes:add" } as never, { value: 7 } as never);
                            m.ack();
                        }),
                    );
                },
            });

            const m = message({ n: 1 });

            await dispatchQueueBatch(
                batch("q", [m]),
                { q: { definition: queue, exportName: "q" } },
                {
                    env: { LUNORA_ADMIN_TOKEN: TOKEN, LUNORA_ORIGIN_URL: ORIGIN },
                    fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => platform.dispatch(new Request(url, init)),
                },
            );

            const shard = shards.get("__root__");

            expect(m.acked).toBe(true);
            expect(shard).toBeDefined();
            expect(shard?.shard.sql.exec<{ value: number }>("SELECT value FROM notes").toArray()).toStrictEqual([{ value: 7 }]);
        } finally {
            platform.close();
        }
    });
});

describe("queue delivery through the platform's own queue host", () => {
    it("runs a handler's ctx.run when the batch is polled from createNodePlatform", async () => {
        expect.assertions(2);

        const shards = new Map<string, NodeShard>();
        const shardDos = new Map<string, NotesShardDO>();
        const emails = defineQueue<{ value: number }>({
            handler: async (context, b) => {
                await Promise.all(
                    b.messages.map(async (m) => {
                        await context.run({ __lunoraRef: "notes:add" } as never, { value: m.body.value } as never);
                        m.ack();
                    }),
                );
            },
            maxBatchTimeout: 0,
        });

        const platform: NodePlatform<{ emails: typeof emails }> = createNodePlatform({
            dispatch: { adminToken: TOKEN },
            onFetch: async (request, shard) => {
                shards.set(shard.shardKey, shard);

                let shardDo = shardDos.get(shard.shardKey);

                if (shardDo === undefined) {
                    shardDo = new NotesShardDO(createNodeShardState(shard) as never, {}, shard);
                    shardDos.set(shard.shardKey, shardDo);
                }

                return shardDo.fetch(request);
            },
            // The host hands `onBatch` the batch alone, so the caller supplies the env.
            onQueueBatch: (queueBatch) =>
                dispatchQueueBatch(
                    queueBatch,
                    { emails: { definition: emails, exportName: "emails" } },
                    {
                        env: { LUNORA_ADMIN_TOKEN: TOKEN, LUNORA_ORIGIN_URL: ORIGIN },
                        fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => platform.dispatch(new Request(url, init)),
                    },
                ),
            queues: { emails },
        });

        try {
            await platform.queues?.bindings.emails.send({ value: 11 });

            await expect(platform.queues?.poll()).resolves.toBe(1);

            const shard = shards.get("__root__");

            expect(shard?.shard.sql.exec<{ value: number }>("SELECT value FROM notes").toArray()).toStrictEqual([{ value: 11 }]);
        } finally {
            platform.close();
        }
    });
});

describe("dispatch route without a shard handler", () => {
    it("leaves the message unacked when a handler's ctx.run has no shard to run it", async () => {
        expect.assertions(2);

        const platform = createNodePlatform({ dispatch: { adminToken: TOKEN } });

        try {
            const queue = defineQueue({
                handler: async (context, b) => {
                    await Promise.all(
                        b.messages.map(async (m) => {
                            await context.run({ __lunoraRef: "notes:add" } as never, { value: 7 } as never);
                            m.ack();
                        }),
                    );
                },
            });

            const m = message({ n: 1 });

            // The handler's ctx.run fails, so the batch surfaces the error rather than acking.
            await expect(
                dispatchQueueBatch(
                    batch("q", [m]),
                    { q: { definition: queue, exportName: "q" } },
                    {
                        env: { LUNORA_ADMIN_TOKEN: TOKEN, LUNORA_ORIGIN_URL: ORIGIN },
                        fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => platform.dispatch(new Request(url, init)),
                    },
                ),
            ).rejects.toThrow(/onFetch/);

            // Not acked: the work never ran, so the message must not be dropped.
            expect(m.acked).toBe(false);
        } finally {
            platform.close();
        }
    });
});
