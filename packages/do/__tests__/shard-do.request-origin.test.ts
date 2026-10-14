/**
 * `getCurrentOrigin()` — the origin an `/rpc` request reached the worker on.
 *
 * The generated `buildCtx` hands it to the storage factory as the fallback base
 * for signed object URLs, so it has to be exactly the forwarded value for the
 * dispatch that carried it, and nothing at all for the next one.
 */
import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets: () => [],
        storage: { sql: { exec: vi.fn<(query: string) => unknown>() } },
    };
};

class OriginReadingShard extends ShardDO {
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ origin: this.getCurrentOrigin() ?? null });
    }
}

const rpc = async (shard: OriginReadingShard, headers: Record<string, string>): Promise<{ origin: null | string }> => {
    const response = await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "files:sign" }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
        }),
    );

    const body: { result: { origin: null | string } } = await response.json();

    return body.result;
};

describe("shardDO request origin", () => {
    it("reads the forwarded origin for the dispatch that carried it, and clears it after", async () => {
        expect.assertions(2);

        const shard = new OriginReadingShard(createFakeState(), {});

        const first = await rpc(shard, { "x-lunora-origin": "https://chat.example.com" });
        const second = await rpc(shard, {});

        expect(first.origin).toBe("https://chat.example.com");
        expect(second.origin).toBeNull();
    });
});
