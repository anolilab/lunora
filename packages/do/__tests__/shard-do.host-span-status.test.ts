import { LunoraError } from "@lunora/errors";
import type { HostSpanLike } from "@lunora/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState, TelemetrySink } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Wiring only — the status policy itself is unit-tested on `applyHostRootSpan`
 * in `@lunora/observability`. This checks that the shard hands it the right
 * verdict through public entry points: the RPC's sent status, and `true` for a
 * trigger.
 */
const statuses = vi.hoisted((): { code: string; message?: string }[] => []);

vi.mock(import("cloudflare:workers"), () => {
    const invocationSpan: HostSpanLike = {
        isTraced: true,
        setAttribute: () => undefined,
        setStatus: (status) => {
            statuses.push(status);
        },
    };
    // Structural stand-in: only the members the bridge feature-detects, so it
    // is cast to the full platform `Tracing` the module type declares.
    const tracing = {
        enterSpan: <T>(_name: string, callback: (span: HostSpanLike) => T): T => callback(invocationSpan),
        getActiveSpan: () => invocationSpan,
    };

    return { tracing: tracing as unknown as Tracing };
});

/**
 * Throws from the handler after only the eager sink registration the generated
 * `buildCtx` performs — no `ctx.trace`, `ctx.span` or `ctx.db`, so the dispatch
 * records no root span. An alarm fails through the host alarm handler.
 */
class ThrowingShard extends ShardDO {
    public thrown: unknown;

    private readonly sink: TelemetrySink = { fuseCloudflareTraces: true };

    public override async handleRpc(): Promise<unknown> {
        this.makeDispatchSpan(this.resolveDispatchAnchor(false), this.sink);

        throw this.thrown;
    }

    protected override async handleAlarmCloudflare(): Promise<void> {
        throw this.thrown;
    }
}

const rpcRequest = (): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "orders:charge" }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const withShard = async (thrown: unknown, run: (shard: ThrowingShard) => Promise<void>): Promise<void> => {
    const database = createSqliteExec();
    let probe: Promise<unknown> = Promise.resolve();
    const state: ShardDOState = {
        acceptWebSocket() {},
        blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => {
            const settled = callback();

            probe = settled;

            return settled;
        },
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };

    try {
        const shard = new ThrowingShard(state, {});

        // The host-tracing probe the constructor starts; dispatches read its verdict.
        await probe;
        shard.thrown = thrown;
        await run(shard);
    } finally {
        database.close();
    }
};

describe("fused host invocation span status", () => {
    beforeEach(() => {
        statuses.length = 0;
    });

    it("marks it failed for a 5xx from a handler that recorded no telemetry", async () => {
        expect.assertions(2);

        await withShard(new Error("User 12345 not found"), async (shard) => {
            const response = await shard.fetch(rpcRequest());

            expect(response.status).toBe(500);
        });

        // Redacted (`standardRules` masks a bare 5-digit run as `<DL>`).
        expect(statuses).toStrictEqual([{ code: "error", message: "User <DL> not found" }]);
    });

    it("leaves it unset for a 4xx", async () => {
        expect.assertions(2);

        await withShard(new LunoraError("FORBIDDEN", "not yours", { status: 403 }), async (shard) => {
            const response = await shard.fetch(rpcRequest());

            expect(response.status).toBe(403);
        });

        expect(statuses).toStrictEqual([]);
    });

    it("marks it failed for a failing alarm, even with a 4xx-coded error", async () => {
        expect.assertions(2);

        await withShard(new LunoraError("FORBIDDEN", "not yours", { status: 403 }), async (shard) => {
            // A prior dispatch registers the sink; a trigger has no ctx of its own.
            await shard.fetch(rpcRequest());
            statuses.length = 0;

            await expect(shard.alarm()).rejects.toThrow("not yours");
        });

        expect(statuses).toStrictEqual([{ code: "error", message: "not yours" }]);
    });
});
