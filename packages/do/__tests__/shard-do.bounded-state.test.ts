import type { SocketAttachment, SqlExec } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Shrink the distinct-path cap so the bound is observable in a handful of
 * dispatches instead of five thousand. Only the constant is replaced; every
 * other export keeps its real implementation, including the durable
 * `recordFunctionMetric` the same cap governs.
 */
vi.mock(import("@lunora/observability"), async (importOriginal) => {
    const actual = await importOriginal();

    // The real constant is declared `= 5000`, so its type is the literal, not
    // `number` — the override has to be widened past it.
    return { ...actual, FUNCTION_METRICS_MAX_PATHS: 3 as unknown as typeof actual.FUNCTION_METRICS_MAX_PATHS };
});

/** A shard whose mutation commits its replay bookkeeping in-transaction, exactly as a generated `handleRpc` mutation branch does. */
class CountingMutationShard extends ShardDO {
    public runs = 0;

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.runs += 1;

            const result = { runs: this.runs };

            this.commitMutationBookkeeping(result);

            return result;
        });
    }

    /** The in-memory per-function counters, which are `private` on the base — read here to assert the bound directly rather than through the durable read the admin RPC prefers. */
    public functionStatPaths(): string[] {
        return [...(this as unknown as { functionStats: Map<string, unknown> }).functionStats.keys()];
    }
}

const makeState = (sql: SqlExec): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const rpcRequest = (functionPath: string, mutationId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-lunora-mutation-id": mutationId,
            "x-lunora-userid": "u1",
        },
        method: "POST",
    });

describe("shardDO in-memory function stats are bounded", () => {
    it("stops admitting new paths at the cap when the idempotency cache is replayed with a fresh path each time", async () => {
        expect.assertions(28);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database.sql), {});

            // Commit once so `(identity, mutationId)` is cached.
            await shard.fetch(rpcRequest("messages:send", "m-1"));

            // Every replay below carries the SAME mutation id, so each one hits
            // the idempotency cache — which is keyed on `(namespace, mutationId)`
            // and never resolves `functionPath` at all, so it can't produce the
            // `FUNCTION_NOT_FOUND` the error path filters on. `functionPath` is
            // caller-controlled and forwarded unchecked, so before the cap this
            // wrote one permanent Map entry per request.
            for (let index = 0; index < 25; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential replays: each must observe the previous one's cache row
                const response = await shard.fetch(rpcRequest(`messages:junk-${String(index)}`, "m-1"));

                expect.soft(response.status).toBe(200);
            }

            // The handler ran exactly once — every replay was served from cache.
            expect(shard.runs).toBe(1);
            expect(shard.functionStatPaths()).toHaveLength(3);
            expect(shard.functionStatPaths()[0]).toBe("messages:send");
        } finally {
            database.close();
        }
    });
});

describe("shardDO idempotency GC throttle", () => {
    it("advances the throttle even when the sweep throws, instead of re-running it inside every later mutation", async () => {
        expect.assertions(7);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const attempts: string[] = [];
            // The sweep is the only statement that DELETEs from the dedup table;
            // failing it stands in for the pre-migration shard / lock / quota
            // failure the surrounding `catch` swallows.
            const failingTrim: SqlExec = {
                exec: <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]) => {
                    if (query.includes("__idempotency") && query.trimStart().toUpperCase().startsWith("DELETE")) {
                        attempts.push(query);

                        throw new Error("trim failed");
                    }

                    return database.sql.exec<Row>(query, ...parameters);
                },
            };

            const shard = new CountingMutationShard(makeState(failingTrim), {});

            for (let index = 0; index < 4; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential mutations: each one's dedup write must land before the next
                const response = await shard.fetch(rpcRequest("messages:send", `m-${String(index)}`));

                expect.soft(response.status).toBe(200);
            }

            // One attempt, not one per mutation: the throttle stamp has to move
            // before the sweep runs, or the failure that prevents it advancing
            // re-runs a failing full-scan DELETE inside every subsequent
            // mutation's write transaction, swallowed and getting more expensive
            // as the untrimmed table grows.
            expect(attempts).toHaveLength(1);
            // The failure stays swallowed — bookkeeping must never fail a
            // mutation whose writes already committed.
            expect(shard.runs).toBe(4);
            expect(attempts[0]).toContain("__idempotency");
        } finally {
            database.close();
        }
    });
});

describe("shardDO releases a departing socket's relayed shape registrations", () => {
    it("posts relay_shape_unsubscribe to its owner on webSocketClose, before the detach and before the attachment is cleared", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const posts: Record<string, unknown>[] = [];
            const ownerStub = {
                fetch: (_url: string, init?: { body?: string }) => {
                    posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

                    return Promise.resolve(new Response(undefined, { status: 204 }));
                },
            };
            const environment = { SHARD: { get: () => ownerStub, getByName: () => ownerStub, idFromName: (id: string) => id } };
            const shard = new CountingMutationShard({ ...makeState(database.sql), id: { name: "room-1::relay::3" } }, environment);

            // Teach the DO its namespace binding the way the runtime does — a
            // relay that cannot address its owner is inert.
            await shard.fetch(
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
                    headers: { "content-type": "application/json", "x-lunora-shard-binding": "SHARD" },
                    method: "POST",
                }),
            );

            const ws = {
                attachment: { connectionId: "conn-9", subs: {} } as SocketAttachment | undefined,
                deserializeAttachment(): unknown {
                    return this.attachment;
                },
                send(): void {},
                serializeAttachment(value: unknown): void {
                    this.attachment = value as SocketAttachment | undefined;
                },
            };

            await shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true);

            // A socket on a RELAY registers its shape in the OWNER's table, which
            // this DO cannot reach with a local DELETE. Without the release the
            // row survives until the whole relay detaches — and every surviving
            // row pins the owner's op-log retention floor.
            expect(posts.map((post) => post["type"])).toStrictEqual(["relay_shape_unsubscribe", "relay_detach"]);
            expect(posts[0]).toMatchObject({ connectionId: "conn-9", relayIndex: 3 });
            // The release must run while the attachment still carries the
            // connection id it is addressed by.
            expect(ws.attachment).toBeUndefined();
        } finally {
            database.close();
        }
    });
});

describe("shardDO webSocketMessage never throws on a dead socket", () => {
    it("swallows a send failure on the malformed-envelope path", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database.sql), {});
            const ws = {
                attachment: { subs: {} } as SocketAttachment,
                deserializeAttachment(): unknown {
                    return this.attachment;
                },
                send(): void {
                    throw new Error("WebSocket is not connected");
                },
                serializeAttachment(value: unknown): void {
                    this.attachment = value as SocketAttachment;
                },
            };

            // Under the hibernation API a thrown `webSocketMessage` is a
            // fatal-channel error — and that path is exactly the one that then
            // skips `webSocketClose`'s durable teardown (workerd dispatches
            // `webSocketError` instead), so an unguarded error frame leaks the
            // very rows the close handler exists to reclaim.
            await expect(shard.webSocketMessage(ws as unknown as WebSocket, "{not json")).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });
});
