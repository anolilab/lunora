import { describe, expect, it, vi } from "vitest";

import type { ForwardableEmailMessageLike } from "../src/inbound/handler";
import { createInboundEmailHandler, dispatchToCirrusFunction } from "../src/inbound/handler";
import type { InboundEmail } from "../src/inbound/parse";

/** A parsed message fixture used by the handler tests (parsing is covered separately). */
const fixture: InboundEmail = {
    attachments: [],
    from: "alice@example.com",
    headers: { subject: "Hi" },
    messageId: "<m-1@example.com>",
    subject: "Hi",
    text: "hello",
    to: ["bob@example.test"],
};

/** Build a fake ForwardableEmailMessage double — no workerd, no `cloudflare:email`. */
const fakeMessage = (overrides: Partial<ForwardableEmailMessageLike> = {}): ForwardableEmailMessageLike => {
    return {
        forward: vi.fn<ForwardableEmailMessageLike["forward"]>(async () => undefined),
        from: "alice@example.com",
        headers: new Headers(),
        raw: new ReadableStream<Uint8Array>(),
        reply: vi.fn<ForwardableEmailMessageLike["reply"]>(async () => undefined),
        setReject: vi.fn<ForwardableEmailMessageLike["setReject"]>(),
        to: "bob@example.test",
        ...overrides,
    };
};

describe("createInboundEmailHandler", () => {
    it("reads raw, parses, and dispatches the parsed message", async () => {
        expect.assertions(4);

        const parse = vi.fn<() => Promise<InboundEmail>>(async () => fixture);
        const dispatch = vi.fn<() => Promise<void>>(async () => undefined);
        const message = fakeMessage();
        const env = { CIRRUS_ADMIN_TOKEN: "secret" };

        const handler = createInboundEmailHandler({ dispatch, parse });

        await handler(message, env, { ctxToken: 1 });

        expect(parse).toHaveBeenCalledWith(message.raw);
        expect(dispatch).toHaveBeenCalledTimes(1);

        const [email, context] = dispatch.mock.calls[0] as unknown as [InboundEmail, { ctx: unknown; env: unknown; message: unknown }];

        expect(email).toBe(fixture);
        expect(context).toMatchObject({ ctx: { ctxToken: 1 }, env, message });
    });

    it("rejects the message via setReject when dispatch throws (default onError)", async () => {
        expect.assertions(2);

        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw new Error("boom");
            },
            parse: async () => fixture,
        });

        await handler(message, {}, undefined);

        expect(message.setReject).toHaveBeenCalledTimes(1);
        expect(message.setReject).toHaveBeenCalledWith("boom");
    });

    it("routes a parse failure through a custom onError instead of setReject", async () => {
        expect.assertions(2);

        const message = fakeMessage();
        const onError = vi.fn<() => void>();
        const handler = createInboundEmailHandler({
            dispatch: async () => undefined,
            onError,
            parse: async () => {
                throw new Error("bad mime");
            },
        });

        await handler(message, {}, undefined);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(message.setReject).not.toHaveBeenCalled();
    });
});

describe("dispatchToCirrusFunction", () => {
    const stubShard = (response: { json: () => Promise<unknown>; ok?: boolean; status?: number }) => {
        const fetch = vi.fn<() => Promise<typeof response>>(async () => response);
        const get = vi.fn<() => { fetch: typeof fetch }>(() => {
            return { fetch };
        });
        const idFromName = vi.fn<(name: string) => string>((name: string) => `id:${name}`);

        return { fetch, get, idFromName, shard: { get, idFromName } };
    };

    it("posts an RpcEnvelope with functionPath/args/shardKey to the root shard", async () => {
        expect.assertions(5);

        const { fetch, idFromName, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const dispatch = dispatchToCirrusFunction({ functionPath: "inbound:onEmail", shard });

        await dispatch(fixture, { ctx: undefined, env: { CIRRUS_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        expect(idFromName).toHaveBeenCalledWith("__root__");

        const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];

        expect(url).toBe("https://shard.internal/rpc");
        expect(init.headers.authorization).toBe("Bearer secret");

        const envelope = JSON.parse(init.body) as { args: unknown; functionPath: string; shardKey: string };

        expect(envelope).toMatchObject({ functionPath: "inbound:onEmail", shardKey: "__root__" });
        expect(envelope.args).toMatchObject({ from: "alice@example.com", subject: "Hi" });
    });

    it("honours a custom shardKey and resolveArgs", async () => {
        expect.assertions(2);

        const { fetch, idFromName, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const dispatch = dispatchToCirrusFunction({
            functionPath: "inbound:onEmail",
            resolveArgs: (email) => {
                return { subject: email.subject };
            },
            shard,
            shardKey: "tenant-7",
        });

        await dispatch(fixture, { ctx: undefined, env: { CIRRUS_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        expect(idFromName).toHaveBeenCalledWith("tenant-7");

        const [, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
        const envelope = JSON.parse(init.body) as { args: unknown; shardKey: string };

        expect(envelope).toStrictEqual({ args: { subject: "Hi" }, functionPath: "inbound:onEmail", shardKey: "tenant-7" });
    });

    it("throws (so the handler rejects) when the admin token is missing", async () => {
        expect.assertions(1);

        const { shard } = stubShard({
            json: async () => {
                return {};
            },
            ok: true,
        });
        const dispatch = dispatchToCirrusFunction({ functionPath: "inbound:onEmail", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: {}, message: fakeMessage() })).rejects.toThrow(/CIRRUS_ADMIN_TOKEN/);
    });

    it("throws on a non-2xx shard response", async () => {
        expect.assertions(1);

        const { shard } = stubShard({
            json: async () => {
                return {};
            },
            ok: false,
            status: 500,
        });
        const dispatch = dispatchToCirrusFunction({ functionPath: "inbound:onEmail", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: { CIRRUS_ADMIN_TOKEN: "secret" }, message: fakeMessage() })).rejects.toThrow(
            /failed \(HTTP 500\)/,
        );
    });

    it("throws when the RPC envelope returns an error", async () => {
        expect.assertions(1);

        const { shard } = stubShard({
            json: async () => {
                return { error: { message: "no such function" } };
            },
            ok: true,
        });
        const dispatch = dispatchToCirrusFunction({ functionPath: "inbound:missing", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: { CIRRUS_ADMIN_TOKEN: "secret" }, message: fakeMessage() })).rejects.toThrow(/returned an error/);
    });

    it("end-to-end: handler + dispatcher rejects the message when the shard errors", async () => {
        expect.assertions(2);

        const { shard } = stubShard({
            json: async () => {
                return { error: "boom" };
            },
            ok: true,
        });
        const message = fakeMessage();

        const handler = createInboundEmailHandler({
            dispatch: dispatchToCirrusFunction({ functionPath: "inbound:onEmail", shard }),
            parse: async () => fixture,
        });

        await handler(message, { CIRRUS_ADMIN_TOKEN: "secret" }, undefined);

        expect(message.setReject).toHaveBeenCalledTimes(1);
        expect(message.setReject).toHaveBeenCalledWith(expect.stringContaining("returned an error"));
    });
});
