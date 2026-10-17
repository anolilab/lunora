import { afterEach, describe, expect, it } from "vitest";

import { cleanupDatabases, dataFrames, setup, TestShard } from "./_helpers/delivery-authorization";

class UnrelatedWriteShard extends TestShard {
    public override handleRpc(): Promise<unknown> {
        this.recordChangedTable("unrelated");
        return Promise.resolve("ok");
    }
}

describe("delivery-authorized subscription refresh skipping", () => {
    afterEach(cleanupDatabases);

    it("reauthorizes every write but skips an unchanged read until its permit changes", async () => {
        expect.hasAssertions();

        const test = setup();
        const shard = new UnrelatedWriteShard(test.state, {}, { deliveryAuthorization: test.authority });

        await test.send(shard);

        expect(shard.queryCalls).toBe(1);
        expect(test.authority.mock.calls.filter(([request]) => request.transport === "subscription")).toHaveLength(1);

        const seedFrames = test.socket.frames.length;

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:write", args: {} }),
                headers: { "x-lunora-userid": "alice" },
            }),
        );

        // Current authority is still consulted, but the unchanged memo proves
        // an unrelated write cannot alter this query's result.
        expect(test.authority.mock.calls.filter(([request]) => request.transport === "subscription")).toHaveLength(2);
        expect(shard.queryCalls).toBe(1);
        expect(test.socket.frames).toHaveLength(seedFrames);

        // A fresh permit invalidates the old baseline even though the query's
        // database read set still misses the write.
        test.regrant();

        shard.rows = ["new-policy"];
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:write", args: {} }),
                headers: { "x-lunora-userid": "alice" },
            }),
        );

        expect(test.authority.mock.calls.filter(([request]) => request.transport === "subscription")).toHaveLength(3);
        expect(shard.queryCalls).toBe(2);
        expect(test.socket.frames.length).toBeGreaterThan(seedFrames);
        expect(dataFrames(test.socket).map((frame) => frame.type)).toEqual(["data", "data"]);
        expect(dataFrames(test.socket).at(-1)?.data).toEqual(["new-policy"]);
    });
});
