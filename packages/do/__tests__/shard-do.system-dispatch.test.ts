import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface FakeState extends ShardDOState {
    storage: { sql: { databaseSize?: number; exec: (query: string) => unknown } };
}

const createFakeState = (): FakeState => {
    return {
        acceptWebSocket: vi.fn<ShardDOState["acceptWebSocket"]>(),
        getWebSockets: vi.fn<ShardDOState["getWebSockets"]>(() => []),
        id: { name: "test-shard" },
        storage: { sql: { databaseSize: undefined, exec: vi.fn<(query: string) => unknown>() } },
    };
};

/**
 * Probe shard whose `handleRpc` reports the protected system-dispatch flag —
 * the signal a generated `handleRpc` consults to decide whether an `internal`
 * function may run. Exercises the real `/rpc` fetch path (not a stubbed shard),
 * so it verifies the `x-lunora-system` header is honored end-to-end.
 */
class ProbeShardDO extends ShardDO {
    public constructor(state: ShardDOState) {
        super(state, {});
    }

    public override async handleRpc(): Promise<unknown> {
        return { system: this.isSystemDispatch() };
    }
}

const readSystemFlag = async (shard: ProbeShardDO, headers: Record<string, string>): Promise<boolean> => {
    const response = await shard.fetch(
        new Request("https://shard.invalid/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "noop" }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
        }),
    );

    const body: { result: { system: boolean } } = await response.json();

    return body.result.system;
};

describe("shardDO system dispatch", () => {
    it("isSystemDispatch() is true only when the x-lunora-system header is set", async () => {
        expect.assertions(2);

        const shard = new ProbeShardDO(createFakeState());

        await expect(readSystemFlag(shard, { "x-lunora-system": "1" })).resolves.toBe(true);
        await expect(readSystemFlag(shard, {})).resolves.toBe(false);
    });

    it("clears the system flag between requests so it never leaks", async () => {
        expect.assertions(1);

        const shard = new ProbeShardDO(createFakeState());

        await readSystemFlag(shard, { "x-lunora-system": "1" });

        await expect(readSystemFlag(shard, {})).resolves.toBe(false);
    });
});
