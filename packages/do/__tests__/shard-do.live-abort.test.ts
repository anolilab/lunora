import { describe, expect, it } from "vitest";

import { ShardDO } from "../src/shard-do";

class LiveShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the live path never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }
}

const makeShard = (): LiveShard => new LiveShard({ acceptWebSocket() {}, getWebSockets: () => [], storage: { sql: {} } }, {});

const control = (shard: LiveShard, connectionId: string): Promise<Response> =>
    shard.fetch(
        new Request("https://x/_lunora/live/control", {
            body: JSON.stringify({ action: "subscribe", connectionId, stream: "s", subscriptionId: "s1", topic: "feed" }),
            method: "POST",
        }),
    );

describe("shardDO: live SSE connection teardown", () => {
    it("deregisters the subscriber when the request is aborted, without a stream cancel", async () => {
        expect.assertions(2);

        const shard = makeShard();
        const controller = new AbortController();
        const response = await shard.fetch(new Request("https://x/_lunora/live/connect", { method: "GET", signal: controller.signal }));
        const connectionId = response.headers.get("x-lunora-live-connection") ?? "";

        // An abrupt disconnect: the runtime aborts the request's signal; nobody cancels the body.
        const before = await control(shard, connectionId);

        expect(before.status).not.toBe(404);

        controller.abort();

        const after = await control(shard, connectionId);

        expect(after.status).toBe(404);
    });
});
