import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogEvent } from "../../../shared/log-event";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/** A shard whose handler logs whatever `log` does, into a collecting sink. */
class LoggingShard extends ShardDO {
    public readonly seen: LogEvent[] = [];

    public log?: (logger: ReturnType<ShardDO["makeLogger"]>) => void;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.log?.(
            this.makeLogger(functionPath, {
                onLog: (event: LogEvent) => {
                    this.seen.push(event);
                },
            }),
        );

        return { ok: true };
    }
}

const run = async (log: NonNullable<LoggingShard["log"]>): Promise<LogEvent> => {
    const database = createSqliteExec();

    try {
        const shard = new LoggingShard(
            {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
            },
            {},
        );

        shard.log = log;
        await shard.fetch(new Request("https://shard.internal/rpc", { body: JSON.stringify({ args: {}, functionPath: "a:b" }), method: "POST" }));

        return shard.seen[0]!;
    } finally {
        database.close();
    }
};

describe("shardDO ctx.log errors", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("carries a console-style logged Error as `error`, and renders it in the message", async () => {
        expect.assertions(3);

        vi.spyOn(console, "error").mockImplementation(() => {});

        const event = await run((log) => {
            log.error("charge failed", new TypeError("card declined"));
        });

        expect(event.message).toBe("charge failed TypeError: card declined");
        expect(event.error).toMatchObject({ message: "card declined", name: "TypeError" });
        expect(event.error?.stack).toContain("TypeError: card declined");
    });

    it("finds an Error passed as a field, and keeps its stack and cause in the field instead of `{}`", async () => {
        expect.assertions(5);

        vi.spyOn(console, "error").mockImplementation(() => {});

        const event = await run((log) => {
            log.error("charge failed", { err: new RangeError("too large", { cause: new Error("limit 100") }), orderId: "o-1" });
        });

        expect(event.error).toMatchObject({ message: "too large", name: "RangeError" });
        expect(event.fields?.orderId).toBe("o-1");

        const field = JSON.parse(String(event.fields?.err)) as { cause: { message: string; stack: string }; message: string; name: string; stack: string };

        expect(field).toMatchObject({ cause: { message: "limit 100", name: "Error" }, message: "too large", name: "RangeError" });
        expect(field.stack).toContain("RangeError: too large");
        expect(field.cause.stack).toContain("Error: limit 100");
    });

    it("keeps an Error nested inside a field object instead of writing `{}`", async () => {
        expect.assertions(1);

        vi.spyOn(console, "error").mockImplementation(() => {});

        const event = await run((log) => {
            log.error("charge failed", { attempt: { err: new TypeError("card declined"), n: 2 } });
        });

        expect(JSON.parse(String(event.fields?.attempt))).toMatchObject({ err: { message: "card declined", name: "TypeError" }, n: 2 });
    });

    it("finds an Error in a `with()` bound field and in a structured `event()`", async () => {
        expect.assertions(2);

        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const bound = await run((log) => {
            log.with({ err: new TypeError("bound") }).error("charge failed");
        });
        const structured = await run((log) => {
            log.event("charge.failed", { err: new TypeError("structured") });
        });

        expect(bound.error).toMatchObject({ message: "bound", name: "TypeError" });
        expect(structured.error).toMatchObject({ message: "structured", name: "TypeError" });
    });

    it("leaves `error` off a line that logged no Error", async () => {
        expect.assertions(1);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const event = await run((log) => {
            log.info("charged", { orderId: "o-1" });
        });

        expect(event).not.toHaveProperty("error");
    });
});
