import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/commands/run.js";
import { runRpcCommand } from "../../src/commands/run.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => {
 return {
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
};
};

describe("cirrus run", () => {
    it("pOSTs the RPC payload to the configured URL", async () => {
        expect.assertions(4);

        const calls: { body: unknown; url: string }[] = [];

        const fetchImpl: FetchLike = async (url, init) => {
            calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, url });

            return {
                json: async () => { return { ok: true, result: 42 }; },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runRpcCommand({
            args: JSON.stringify({ channelId: "channel:1", text: "hi" }),
            fetchImpl,
            functionPath: "messages:send",
            logger: silentLogger(),
            url: "http://localhost:9999",
        });

        expect(result.code).toBe(0);
        expect(result.requestUrl).toBe("http://localhost:9999/_cirrus/rpc");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({
            args: { channelId: "channel:1", text: "hi" },
            functionPath: "messages:send",
        });
    });

    it("attaches --shard to the payload when given", async () => {
        expect.assertions(1);

        const calls: { body: unknown }[] = [];

        const fetchImpl: FetchLike = async (_url, init) => {
            calls.push({ body: init?.body ? JSON.parse(init.body) : undefined });

            return {
                json: async () => { return { ok: true }; },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        await runRpcCommand({
            fetchImpl,
            functionPath: "messages:list",
            logger: silentLogger(),
            shard: "channel:42",
        });

        expect((calls[0]?.body as { shardKey?: string })?.shardKey).toBe("channel:42");
    });

    it("returns non-zero on HTTP error responses", async () => {
        expect.assertions(1);

        const fetchImpl: FetchLike = async () => {
 return {
            json: async () => { return { error: "boom" }; },
            ok: false,
            status: 500,
            text: async () => "",
        };
};

        const result = await runRpcCommand({
            fetchImpl,
            functionPath: "x:y",
            logger: silentLogger(),
        });

        expect(result.code).toBe(1);
    });

    it("returns non-zero when --args is invalid JSON", async () => {
        expect.assertions(2);

        const errors: string[] = [];

        const fetchImpl: FetchLike = async () => {
 return {
            json: async () => { return {}; },
            ok: true,
            status: 200,
            text: async () => "",
        };
};

        const result = await runRpcCommand({
            args: "not json",
            fetchImpl,
            functionPath: "x:y",
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("failed to parse --args");
    });
});
