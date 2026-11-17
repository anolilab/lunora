import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import type { QueryReadScope } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { makeCdcShardFixture } from "./shared";

/**
 * One `/rpc` dispatch through `ShardDO.fetch`, end to end on a CDC shard over
 * real SQLite: envelope parse, arg decode, the handler's indexed read, the
 * result encode, and the per-dispatch bookkeeping every request pays — function
 * metrics and the request-log row, whose arg and identity redaction is the
 * costly part. The identity and args repeat across requests, as one signed-in
 * client re-reading one channel does.
 *
 * The direct insert case writes one row with no live subscriber, so it measures the
 * write and its post-commit flush, not a fan-out (see `refresh-fanout`).
 */

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { authorId: { kind: "string" }, channelId: { kind: "string" }, text: { kind: "string" } },
        },
    },
};

const identityHeader = JSON.stringify({ email: "alice@example.com", name: "Alice", roles: ["member"] });

class RpcBenchShard extends ShardDO {
    public override async handleRpc(functionPath: string, args: Record<string, unknown>, _headroom?: unknown, scope?: QueryReadScope): Promise<unknown> {
        const db = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table, delta.indexKeys);
            },
            cdc: true,
            onRead: this.getCtxDbReadHook(scope),
            schema,
            sql: this.sql as Parameters<typeof createShardContextDatabase>[0]["sql"],
        });

        if (functionPath === "messages:send") {
            return db.insert("messages", args);
        }

        return db
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", args["channelId"]))
            .order("desc")
            .take(20);
    }

    // eslint-disable-next-line class-methods-use-this -- bench stub: one mutation path
    protected override isMutationFunction(functionPath: string): boolean {
        return functionPath === "messages:send";
    }
}

const rpc = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json", "x-lunora-identity": identityHeader, "x-lunora-userid": "user_42" },
        method: "POST",
    });

let shard: RpcBenchShard;
let sent = 0;

beforeAll(async () => {
    const { state } = makeCdcShardFixture(schema);

    shard = new RpcBenchShard(state, {});

    for (let index = 0; index < 200; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed keeps the fixture deterministic
        await shard.fetch(rpc("messages:send", { authorId: `user_${String(index % 7)}`, channelId: `c${String(index % 4)}`, text: `hello ${String(index)}` }));
    }
});

describe("ShardDO.fetch — /rpc dispatch", () => {
    bench("query: 20-row indexed read, repeated args + identity", async () => {
        const response = await shard.fetch(rpc("messages:list", { channelId: "c1" }));

        await response.text();
    });

    bench("direct insert: one row, no subscribers", async () => {
        sent += 1;

        const response = await shard.fetch(rpc("messages:send", { authorId: "user_1", channelId: "c1", text: `message ${String(sent)}` }));

        await response.text();
    });
});
