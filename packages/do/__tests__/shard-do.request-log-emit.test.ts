import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const { calls } = vi.hoisted(() => {
    return { calls: { appended: [] as unknown[], emitted: [] as unknown[] } };
});

vi.mock(import("@lunora/observability"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        appendRequestLogEntry: (...args: Parameters<typeof actual.appendRequestLogEntry>) => {
            const redacted = actual.appendRequestLogEntry(...args);

            calls.appended.push(redacted);

            return redacted;
        },
        emitRequestLogEvent: (...args: Parameters<typeof actual.emitRequestLogEvent>) => {
            calls.emitted.push(args[2]);

            actual.emitRequestLogEvent(...args);
        },
    };
});

class EchoShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; every dispatch succeeds
    public override async handleRpc(): Promise<unknown> {
        return { ok: true };
    }
}

describe("shardDO request-log emit", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hands the Logpush event the redaction the durable write already made", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            const state = {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: database.sql },
            } as unknown as ShardDOState;
            const shard = new EchoShard(state, { LUNORA_REQUEST_LOG_EMIT: "1" });

            await shard.fetch(
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: { channel: "c1" }, functionPath: "messages:list" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            expect(calls.appended[0]).toStrictEqual({ args: '{"channel":"c1"}', identity: undefined });
            expect(calls.emitted).toHaveLength(1);
            expect(calls.emitted[0]).toBe(calls.appended[0]);
        } finally {
            database.close();
        }
    });
});
