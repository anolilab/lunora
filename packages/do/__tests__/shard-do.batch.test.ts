import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {
            /* no sockets in batch tests */
        },
        getWebSockets() {
            return [];
        },
        id: { name: "root" },
        storage: { sql: { databaseSize: 0, exec: vi.fn<(query: string) => unknown>() } },
    };
};

/** Records every dispatched call and returns a per-call result; throws for `boom:*`. */
class BatchShard extends ShardDO {
    public calls: { args: Record<string, unknown>; functionPath: string; userId: string | undefined }[] = [];

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ args, functionPath, userId: this.getCurrentUserId() });

        if (functionPath.startsWith("boom")) {
            throw new Error("kaboom");
        }

        return { echoed: functionPath };
    }
}

const batch = (calls: unknown[], headers: Record<string, string> = {}): Request =>
    new Request("https://shard.internal/rpc-batch", {
        body: JSON.stringify({ calls }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

describe("shardDO /rpc-batch", () => {
    it("dispatches every entry through handleRpc and returns per-id results in order", async () => {
        expect.assertions(3);

        const shard = new BatchShard(createFakeState(), {});
        const response = await shard.fetch(
            batch([
                { args: { a: 1 }, functionPath: "docs:one", id: 0 },
                { args: { b: 2 }, functionPath: "docs:two", id: 1 },
            ]),
        );

        // `Response.json()` is `unknown` under tsc (workers-types) so this cast is
        // required to type-check; eslint's project service resolves it as `any` and
        // wrongly reports the assertion "unnecessary" — hence the disable.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc sees Response.json() as `unknown`; the cast is load-bearing for lint:types
        const body = (await response.json()) as { results: { body: { result?: { echoed?: string } }; id: number }[] };

        expect(shard.calls.map((c) => c.functionPath)).toStrictEqual(["docs:one", "docs:two"]);
        expect(body.results.map((r) => r.id)).toStrictEqual([0, 1]);
        expect(body.results.map((r) => r.body.result?.echoed)).toStrictEqual(["docs:one", "docs:two"]);
    });

    it("wire-decodes each entry's args for the handler and shares the batch identity", async () => {
        expect.assertions(2);

        const shard = new BatchShard(createFakeState(), {});
        // `count` is a wire-encoded bigint (as the client would send it).
        await shard.fetch(batch([{ args: { count: ["$lunora.wire$", "bigint", "9"] }, functionPath: "docs:big", id: 0 }], { "x-lunora-userid": "u_42" }));

        expect(shard.calls[0]?.args).toStrictEqual({ count: 9n });
        expect(shard.calls[0]?.userId).toBe("u_42");
    });

    it("captures a failing entry per-slot without aborting the rest", async () => {
        expect.assertions(3);

        const shard = new BatchShard(createFakeState(), {});
        const response = await shard.fetch(
            batch([
                { args: {}, functionPath: "docs:ok", id: 0 },
                { args: {}, functionPath: "boom:bad", id: 1 },
                { args: {}, functionPath: "docs:after", id: 2 },
            ]),
        );

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc sees Response.json() as `unknown`; the cast is load-bearing for lint:types
        const body = (await response.json()) as { results: { body: { result?: unknown }; status: number }[] };

        expect(body.results[0]?.body.result).toStrictEqual({ echoed: "docs:ok" });
        expect(body.results[1]?.status).toBe(500);
        // The entry after the failure still ran (fail-per-slot, not fail-fast).
        expect(body.results[2]?.body.result).toStrictEqual({ echoed: "docs:after" });
    });
});
