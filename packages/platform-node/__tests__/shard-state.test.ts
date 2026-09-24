import { createShardHost, createSocketHost } from "@lunora/platform-cloudflare";
import { describe, expect, it } from "vitest";

import { createNodeShardRegistry } from "../src/node-shard-registry";
import { createNodeShardState } from "../src/node-shard-state";

/**
 * `ShardDO`'s constructor does exactly two things with the `state` it is
 * handed: `createShardHost(state)` and `createSocketHost(state)`. So driving
 * those two Cloudflare adapters over a Node-backed state is the same test as
 * "can `ShardDO` run on this host", without standing up a whole app to find
 * out.
 *
 * The point is that every member is backed by something real. A state double
 * whose `setAlarm` resolved without arming, or whose `exec` returned an empty
 * cursor, would satisfy the types and let a shard report success while doing
 * nothing — the failure mode this branch has been chasing since the scheduler.
 */
describe("createNodeShardState", () => {
    // `async` and awaited: a sync `try/finally` around an async body closes the
    // registry the moment the promise is *returned*, not when it settles, so
    // every await inside would run against a closed connection.
    const withShard = async <T>(run: (state: ReturnType<typeof createNodeShardState>) => Promise<T> | T): Promise<T> => {
        const registry = createNodeShardRegistry();

        try {
            return await run(createNodeShardState(registry.shardFor("tenant-42")));
        } finally {
            registry.close();
        }
    };

    it("satisfies the Cloudflare ShardHost adapter over real SQLite", async () => {
        expect.assertions(3);

        await withShard(async (state) => {
            const host = createShardHost(state as never);

            expect(host.shardKey).toBe("tenant-42");

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
                host.sql.exec("INSERT INTO notes (id, body) VALUES (?, ?)", 1, "hello");
            });

            // Through the Cloudflare adapter's own cursor handling, not this
            // package's — the adapter passes the cursor straight through, so a
            // shape mismatch surfaces here rather than deep inside the engine.
            expect(host.sql.exec("SELECT body FROM notes WHERE id = 1").one()).toStrictEqual({ body: "hello" });

            // A rolled-back transaction must leave nothing behind: `ShardDO`
            // wraps every mutation in one, so a state whose `transaction` did
            // not actually roll back would commit half-applied writes.
            await expect(
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id, body) VALUES (2, 'gone')");
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
        });
    });

    it("arms and clears a durable alarm through the adapter", async () => {
        expect.assertions(2);

        await withShard(async (state) => {
            const host = createShardHost(state as never);
            const target = Date.now() + 60_000;

            await host.alarms.set(target);

            await expect(host.alarms.get()).resolves.toBe(target);

            await host.alarms.delete();

            await expect(host.alarms.get()).resolves.toBeNull();
        });
    });

    it("accepts and enumerates sockets through the Cloudflare SocketHost adapter", async () => {
        expect.assertions(2);

        await withShard((state) => {
            const sockets = createSocketHost(state as never);
            const raw = { send: () => undefined };

            sockets.accept(raw, { user: "ada" }, ["room-a"]);

            // Tagged enumeration has to be exact — a superset fans a shape
            // update across subscriptions that never asked for it.
            expect(sockets.getSockets("room-a")).toHaveLength(1);
            expect(sockets.getSockets("room-b")).toHaveLength(0);
        });
    });

    it("enumerates the same socket object it accepted, so fan-out reaches the wire", async () => {
        expect.assertions(6);

        await withShard((state) => {
            const sockets = createSocketHost(state as never);
            const sent: unknown[] = [];
            let closed = false;
            const raw = {
                close: () => {
                    closed = true;
                },
                send: (frame: unknown) => sent.push(frame),
            };

            const accepted = sockets.accept(raw, { connectionId: "c-1" }, ["room-a"]);
            const listed = sockets.getSockets();

            // One socket, one identity. `accept` and `handleFor` answer the
            // transport (the adapter's contract); a `getSockets` that answered
            // anything else makes per-socket memos and every `ws !== closing`
            // comparison — `announceDrain`'s, a whisper sender's self-exclusion
            // — miss on the fan-out path.
            expect(listed[0]).toBe(accepted);
            expect(sockets.handleFor(raw)).toBe(listed[0]);
            expect(sockets.idFor(listed[0] as never)).toBe(sockets.idFor(accepted));

            // The frame every poke/delta/relay broadcast writes.
            listed[0]?.send("shape_poke");

            expect(sent).toStrictEqual(["shape_poke"]);

            listed[0]?.close(1000, "bye");

            expect(closed).toBe(true);
            expect(sockets.getSockets()).toHaveLength(0);
        });
    });
});
