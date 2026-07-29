import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/commands/run/handler";
import { runRpcCommand } from "../../src/commands/run/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

describe("lunora run", () => {
    it("pOSTs the RPC payload to the configured URL", async () => {
        expect.assertions(4);

        const calls: { body: unknown; url: string }[] = [];

        const fetchImpl: FetchLike = async (url, init) => {
            calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, url });

            return {
                json: async () => {
                    return { ok: true, result: 42 };
                },
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
        expect(result.requestUrl).toBe("http://localhost:9999/_lunora/rpc");
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
                json: async () => {
                    return { ok: true };
                },
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
                json: async () => {
                    return { error: "boom" };
                },
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

    it("surfaces a non-JSON error body without throwing on a consumed stream", async () => {
        expect.assertions(3);

        // Mirror undici/Node fetch: reading the body twice throws. The old
        // code did `json()` (which disturbs the stream on non-JSON input) then
        // fell back to `text()` on the consumed body — throwing "Body is
        // unusable" and masking the real server message. The fix reads the
        // body exactly once via text(), so this must surface the plain text.
        let bodyRead = false;

        const fetchImpl: FetchLike = async () => {
            return {
                json: async () => {
                    bodyRead = true;

                    throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON");
                },
                ok: false,
                status: 502,
                text: async () => {
                    if (bodyRead) {
                        throw new TypeError("Body is unusable");
                    }

                    bodyRead = true;

                    return "<html><body>502 Bad Gateway</body></html>";
                },
            };
        };

        const result = await runRpcCommand({
            fetchImpl,
            functionPath: "x:y",
            logger: silentLogger(),
        });

        expect(result.code).toBe(1);
        expect(bodyRead).toBe(true);
        expect(result.body).toBe("<html><body>502 Bad Gateway</body></html>");
    });

    it("returns non-zero when --args is invalid JSON", async () => {
        expect.assertions(2);

        const errors: string[] = [];

        const fetchImpl: FetchLike = async () => {
            return {
                json: async () => {
                    return {};
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runRpcCommand({
            args: "not json",
            fetchImpl,
            functionPath: "x:y",
            logger: { ...silentLogger(), error: (message) => errors.push(message) },
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("failed to parse --args");
    });
});

describe("lunora run --as", () => {
    /** Capture the single request a run makes, answering with `status`/`text`. */
    const capturing = (
        calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[],
        replyStatus = 200,
        replyText = "{}",
    ): FetchLike => {
        const reply = { status: replyStatus, text: replyText };

        return async (url, init) => {
            calls.push({ body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}, headers: init?.headers, url });

            return {
                json: async () => JSON.parse(reply.text) as unknown,
                ok: reply.status < 400,
                status: reply.status,
                text: async () => reply.text,
            };
        };
    };

    it("dispatches through the admin runAs op, nesting the target call", async () => {
        expect.assertions(3);

        const calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[] = [];

        await runRpcCommand({
            args: JSON.stringify({ text: "hi" }),
            as: "user_123",
            fetchImpl: capturing(calls),
            functionPath: "messages:send",
            logger: silentLogger(),
            token: "admin-secret",
            url: "http://localhost:9999",
        });

        // A plain RPC carries no session, so an app with `authorizeShard` denies
        // it; `runAs` forges the identity and is admin-gated instead.
        expect(calls[0]?.body["functionPath"]).toBe("__lunora_admin__:runAs");
        // `identity` is absent, not null: an undefined claims bag drops out of the JSON body.
        expect(calls[0]?.body["args"]).toStrictEqual({ args: { text: "hi" }, functionPath: "messages:send", userId: "user_123" });
        expect(calls[0]?.headers?.["authorization"]).toBe("Bearer admin-secret");
    });

    it("forwards extra claims alongside the user id", async () => {
        expect.assertions(1);

        const calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[] = [];

        await runRpcCommand({
            as: "user_123",
            claims: JSON.stringify({ org: "acme" }),
            fetchImpl: capturing(calls),
            functionPath: "messages:list",
            logger: silentLogger(),
            token: "admin-secret",
            url: "http://localhost:9999",
        });

        expect((calls[0]?.body["args"] as Record<string, unknown>)["identity"]).toStrictEqual({ org: "acme" });
    });

    it("refuses to run as an identity without an admin bearer", async () => {
        expect.assertions(2);

        const calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[] = [];
        const messages: string[] = [];
        const logger = { ...silentLogger(), error: (message: string) => messages.push(message) };

        // A remote target never falls back to `.dev.vars`, so this has no source.
        const result = await runRpcCommand({
            as: "user_123",
            fetchImpl: capturing(calls),
            functionPath: "messages:list",
            logger,
            url: "https://app.example.com",
        });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
    });

    it("sends the admin bearer for a reserved admin path even without --as", async () => {
        expect.assertions(2);

        const calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[] = [];

        await runRpcCommand({
            fetchImpl: capturing(calls),
            functionPath: "__lunora_admin__:listTables",
            logger: silentLogger(),
            token: "admin-secret",
            url: "http://localhost:9999",
        });

        expect(calls[0]?.headers?.["authorization"]).toBe("Bearer admin-secret");
        expect(calls[0]?.body["functionPath"]).toBe("__lunora_admin__:listTables");
    });

    it("points a shard denial at --as instead of leaving the operator to guess", async () => {
        expect.assertions(1);

        const calls: { body: Record<string, unknown>; headers?: Record<string, string>; url: string }[] = [];
        const messages: string[] = [];
        const logger = { ...silentLogger(), info: (message: string) => messages.push(message) };

        await runRpcCommand({
            fetchImpl: capturing(calls, 403, '{"error":{"code":"FORBIDDEN_SHARD","message":"Forbidden shard"}}'),
            functionPath: "messages:list",
            logger,
            url: "http://localhost:9999",
        });

        expect(messages.some((message) => message.includes("--as"))).toBe(true);
    });
});
