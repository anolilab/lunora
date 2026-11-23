import { readFunctionMetricIndexHits, readFunctionMetricScans } from "@lunora/observability";
import { SCAN_DEP } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "collectors-admin";

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
}

const defer = (): Deferred => {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((_resolve) => {
        resolve = _resolve;
    });

    return { promise, resolve };
};

/**
 * Both paths park on a gate the test controls. `first:path` starts first and is
 * released while `second:path` is still mid-handler, so its `endDispatch` lands
 * between `second:path`'s two collector writes.
 */
class InterleavingShard extends ShardDO {
    public readonly gates = {
        first: { parked: defer(), release: defer() },
        second: { parked: defer(), release: defer() },
    };

    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "first:path") {
            this.gates.first.parked.resolve();
            await this.gates.first.release.promise;
        }

        if (functionPath === "second:path") {
            this.getCtxDbIndexUseHook()("messages", "beforePark");
            this.gates.second.parked.resolve();
            await this.gates.second.release.promise;
            this.getCtxDbIndexUseHook()("messages", "afterPark");
            this.getCtxDbReadHook()("posts", SCAN_DEP);
        }

        return { ok: true };
    }
}

const rpc = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("shardDO dispatch collectors under interleaving", () => {
    it("keeps a running dispatch's index hits and scans when an earlier dispatch finishes", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const state: ShardDOState = {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
            };
            const shard = new InterleavingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_METRICS_FLUSH_EVERY: "1" });

            const first = shard.fetch(rpc("first:path"));

            await shard.gates.first.parked.promise;

            const second = shard.fetch(rpc("second:path"));

            await shard.gates.second.parked.promise;
            shard.gates.first.release.resolve();
            await first;
            shard.gates.second.release.resolve();
            await second;

            expect(readFunctionMetricIndexHits(database.sql)).toEqual([
                { index: "afterPark", reads: 1, table: "messages" },
                { index: "beforePark", reads: 1, table: "messages" },
            ]);
            expect(readFunctionMetricScans(database.sql).get("second:path")).toEqual([{ scans: 1, table: "posts" }]);
        } finally {
            database.close();
        }
    });
});
