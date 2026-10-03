import { LunoraError } from "@lunora/errors";
import type { HostSpanLike } from "@lunora/observability";
import { describe, expect, it, vi } from "vitest";

import type { ShardDOState, TelemetrySink } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

type Status = Parameters<NonNullable<HostSpanLike["setStatus"]>>[0];

/**
 * Two host spans so the assertions can tell them apart: `custom` is what
 * `tracing.enterSpan` hands a fused `ctx.trace`, `root` is what
 * `tracing.getActiveSpan()` returns once every custom span has ended — the
 * invocation span the dispatch root mirror writes to.
 */
const host = vi.hoisted(() => {
    const makeSpan = () => {
        const statuses: { code: string; message?: string }[] = [];

        return {
            isTraced: true,
            setAttribute: () => undefined,
            setStatus: (status: { code: string; message?: string }) => {
                statuses.push(status);
            },
            statuses,
        };
    };

    return { custom: makeSpan(), root: makeSpan() };
});

vi.mock(import("cloudflare:workers"), () => {
    // Structural stand-in: only the members the bridge feature-detects, so it
    // is cast to the full platform `Tracing` the module type declares.
    const tracing = {
        enterSpan: <T>(_name: string, callback: (span: HostSpanLike) => T): T => callback(host.custom),
        getActiveSpan: () => host.root,
    };

    return { tracing: tracing as unknown as Tracing };
});

/** Fused sink; the throw a dispatch ends in is chosen per test. */
class FailingShard extends ShardDO {
    public readonly sink: TelemetrySink = { fuseCloudflareTraces: true };

    public thrown: unknown = new Error("boom");

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const anchor = this.resolveDispatchAnchor(false);

        // A wide-event attribute makes the dispatch record its root span, and
        // registers the fused sink on the dispatch entry.
        this.makeDispatchSpan(anchor, this.sink).setAttribute("order.id", "o-1");

        const tracer = this.makeTracer(functionPath, this.sink, anchor);

        return tracer("work", () => {
            throw this.thrown;
        });
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const rpcRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const dispatch = async (thrown: unknown): Promise<{ customStatuses: Status[]; rootStatuses: Status[]; status: number }> => {
    host.custom.statuses.length = 0;
    host.root.statuses.length = 0;

    const database = createSqliteExec();

    try {
        const shard = new FailingShard(makeState(database), {});

        shard.thrown = thrown;

        const response = await shard.fetch(rpcRequest("orders:charge"));

        return { customStatuses: [...host.custom.statuses] as Status[], rootStatuses: [...host.root.statuses] as Status[], status: response.status };
    } finally {
        database.close();
    }
};

describe("fused host span status for a failed dispatch", () => {
    it("marks both the ctx.trace span and the invocation root span failed on a server error", async () => {
        expect.assertions(3);

        const outcome = await dispatch(new Error("User 12345 not found"));

        expect(outcome.status).toBe(500);
        // Redacted (`standardRules` masks a bare 5-digit run as `<DL>`) — the host
        // exports these spans, so neither may carry the raw message.
        expect(outcome.customStatuses).toStrictEqual([{ code: "error", message: "User <DL> not found" }]);
        expect(outcome.rootStatuses).toStrictEqual([{ code: "error", message: "User <DL> not found" }]);
    });

    it("leaves the invocation root span unset for an expected 4xx client error", async () => {
        expect.assertions(3);

        const outcome = await dispatch(new LunoraError("FORBIDDEN", "not yours", { status: 403 }));

        expect(outcome.status).toBe(403);
        // The ctx.trace span still failed — its body threw — so it is marked.
        expect(outcome.customStatuses).toStrictEqual([{ code: "error", message: "not yours" }]);
        expect(outcome.rootStatuses).toStrictEqual([]);
    });
});
