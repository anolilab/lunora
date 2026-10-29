import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogEvent } from "../../../shared/log-event";
import { RAY_ID_HEADER } from "../../../shared/ray-id";
import type { SpanEvent } from "../../../shared/span-event";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const RAY_ID = "8f2a1b3c4d5e6f70";
const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/**
 * A shard whose real dispatch runs one `ctx.trace` span and one `ctx.log` line,
 * both wired to a collecting sink — so what reaches the sink is decided by the
 * base class reading the runtime's forwarded headers, exactly as in production.
 */
class RayShard extends ShardDO {
    public readonly seenLogs: LogEvent[] = [];

    public readonly seenSpans: SpanEvent[] = [];

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const sink = {
            onLog: (event: LogEvent) => {
                this.seenLogs.push(event);
            },
            onSpan: (span: SpanEvent) => {
                this.seenSpans.push(span);
            },
        };
        const trace = this.makeTracer(functionPath, sink, this.getCurrentTrace());

        await trace("work", () => undefined);
        this.recordUserLog(functionPath, "info", ["hello"], "hello", undefined, sink);

        return { ok: true };
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

const rpc = (headers: Record<string, string>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "a:b" }),
        headers: { "content-type": "application/json", traceparent: TRACEPARENT, ...headers },
        method: "POST",
    });

/** Run one dispatch and return what the sink saw. */
const dispatch = async (headers: Record<string, string>): Promise<RayShard> => {
    const database = createSqliteExec();

    try {
        const shard = new RayShard(makeState(database), {});

        await shard.fetch(rpc(headers));

        return shard;
    } finally {
        database.close();
    }
};

describe("shardDO cloudflare ray id", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("stamps the ray id the runtime forwarded onto ctx.log events and ctx.trace spans", async () => {
        expect.assertions(4);

        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const shard = await dispatch({ [RAY_ID_HEADER]: RAY_ID });

        expect(shard.seenLogs[0]?.rayId).toBe(RAY_ID);
        expect(shard.seenSpans[0]?.rayId).toBe(RAY_ID);
        // Correlated to the same trace the traceparent named — the two ride one hop.
        expect(shard.seenLogs[0]?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(shard.seenSpans[0]?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    });

    it("emits the ray id on the Workers Logs console line for ctx.log", async () => {
        expect.assertions(1);

        const lines: string[] = [];

        vi.spyOn(console, "log").mockImplementation((line: unknown) => {
            lines.push(String(line));
        });

        await dispatch({ [RAY_ID_HEADER]: RAY_ID });

        const logLine = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.type === "log");

        expect(logLine?.rayId).toBe(RAY_ID);
    });

    it("carries no ray id when none was forwarded (off the edge)", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const shard = await dispatch({});

        expect(shard.seenLogs[0]).not.toHaveProperty("rayId");
        expect(shard.seenSpans[0]).not.toHaveProperty("rayId");
    });

    it("ignores a malformed forwarded ray id rather than echoing it", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const shard = await dispatch({ [RAY_ID_HEADER]: "<script>" });

        expect(shard.seenLogs[0]).not.toHaveProperty("rayId");
        expect(shard.seenSpans[0]).not.toHaveProperty("rayId");
    });
});
