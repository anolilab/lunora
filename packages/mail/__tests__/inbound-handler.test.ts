import { describe, expect, it, vi } from "vitest";

import type { ForwardableEmailMessageLike } from "../src/inbound/handler";
import { createInboundEmailHandler, dispatchToLunoraFunction } from "../src/inbound/handler";
import type { InboundEmail } from "../src/inbound/parse";

/** A parsed message fixture used by the handler tests (parsing is covered separately). */
const fixture: InboundEmail = {
    attachments: [],
    authentication: { dkim: null, dmarc: null, spf: null },
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
        const env = { LUNORA_ADMIN_TOKEN: "secret" };

        const handler = createInboundEmailHandler({ dispatch, parse });

        await handler(message, env, { ctxToken: 1 });

        expect(parse).toHaveBeenCalledWith(message.raw);
        expect(dispatch).toHaveBeenCalledTimes(1);

        const [email, context] = dispatch.mock.calls[0] as unknown as [InboundEmail, { ctx: unknown; env: unknown; message: unknown }];

        expect(email).toBe(fixture);
        expect(context).toMatchObject({ ctx: { ctxToken: 1 }, env, message });
    });

    it("rejects with a generic reason (not internal error text) when dispatch throws", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw new Error("internal secret detail");
            },
            parse: async () => fixture,
        });

        await handler(message, {}, undefined);

        expect(message.setReject).toHaveBeenCalledTimes(1);
        // Reflected to the (attacker-controlled) sender — must NOT leak internals.
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
        // The real error is logged server-side instead.
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("dropping message"), expect.any(Error));

        consoleError.mockRestore();
    });

    it("runs the verify gate before dispatch and rejects unverified mail", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const dispatch = vi.fn<() => Promise<void>>(async () => undefined);
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch,
            parse: async () => fixture,
            verify: () => false,
        });

        await handler(message, {}, undefined);

        expect(dispatch).not.toHaveBeenCalled();
        expect(message.setReject).toHaveBeenCalledTimes(1);
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");

        consoleError.mockRestore();
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

describe("dispatchToLunoraFunction", () => {
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

        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        expect(idFromName).toHaveBeenCalledWith("__root__");

        const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];

        expect(url).toBe("https://shard.internal/rpc");
        expect(init.headers.authorization).toBe("Bearer secret");

        const envelope = JSON.parse(init.body) as { args: unknown; functionPath: string; shardKey: string };

        expect(envelope).toMatchObject({ functionPath: "inbound:onEmail", shardKey: "__root__" });
        expect(envelope.args).toMatchObject({ from: "alice@example.com", subject: "Hi" });
    });

    it("base64-encodes binary attachment content so it survives JSON serialisation", async () => {
        expect.assertions(3);

        const { fetch, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const bytes = new Uint8Array([0, 1, 2, 255]);
        const withAttachment: InboundEmail = {
            ...fixture,
            attachments: [{ content: bytes, disposition: "attachment", filename: "blob.bin", mimeType: "application/octet-stream" }],
        };

        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await dispatch(withAttachment, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        const [, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
        const envelope = JSON.parse(init.body) as { args: { attachments: { content: string; encoding: string }[] } };
        const [attachment] = envelope.args.attachments;

        // Round-trips intact instead of corrupting to `{}` / index-keyed object.
        expect(attachment?.encoding).toBe("base64");
        expect(attachment?.content).toBe(Buffer.from(bytes).toString("base64"));
        expect([...Buffer.from(attachment?.content ?? "", "base64")]).toStrictEqual([0, 1, 2, 255]);
    });

    it("base64-encodes a large (>32KB) binary attachment correctly across chunk boundaries", async () => {
        expect.assertions(2);

        const { fetch, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        // Larger than the 0x8000 chunk the encoder spreads per `String.fromCharCode`
        // call, so a chunk boundary is crossed — output must still round-trip.
        const bytes = new Uint8Array(0x80_00 * 2 + 5);

        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = index % 256;
        }

        const withAttachment: InboundEmail = {
            ...fixture,
            attachments: [{ content: bytes, disposition: "attachment", filename: "big.bin", mimeType: "application/octet-stream" }],
        };

        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await dispatch(withAttachment, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        const [, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
        const envelope = JSON.parse(init.body) as { args: { attachments: { content: string }[] } };
        const [attachment] = envelope.args.attachments;

        expect(attachment?.content).toBe(Buffer.from(bytes).toString("base64"));
        expect([...Buffer.from(attachment?.content ?? "", "base64")]).toStrictEqual([...bytes]);
    });

    it("honours a custom shardKey and resolveArgs", async () => {
        expect.assertions(2);

        const { fetch, idFromName, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const dispatch = dispatchToLunoraFunction({
            functionPath: "inbound:onEmail",
            resolveArgs: (email) => {
                return { subject: email.subject };
            },
            shard,
            shardKey: "tenant-7",
        });

        await dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

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
        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: {}, message: fakeMessage() })).rejects.toThrow(/LUNORA_ADMIN_TOKEN/);
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
        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() })).rejects.toThrow(
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
        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:missing", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() })).rejects.toThrow(/returned an error/);
    });

    it("end-to-end: handler + dispatcher rejects with a generic reason when the shard errors", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { shard } = stubShard({
            json: async () => {
                return { error: "boom" };
            },
            ok: true,
        });
        const message = fakeMessage();

        const handler = createInboundEmailHandler({
            dispatch: dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard }),
            parse: async () => fixture,
        });

        await handler(message, { LUNORA_ADMIN_TOKEN: "secret" }, undefined);

        expect(message.setReject).toHaveBeenCalledTimes(1);
        // The internal "returned an error" detail must not reach the sender's bounce.
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");

        consoleError.mockRestore();
    });

    it("routes through a jurisdiction-pinned subnamespace when configured", async () => {
        expect.assertions(2);

        const inner = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });
        const jurisdictionCalls: string[] = [];
        const shard = {
            get: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            idFromName: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            jurisdiction: (j: string) => {
                jurisdictionCalls.push(j);

                return inner.shard;
            },
        };

        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", jurisdiction: "us", shard });

        await dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        expect(jurisdictionCalls).toStrictEqual(["us"]);
        expect(inner.idFromName).toHaveBeenCalledWith("__root__");
    });

    it("fails closed when the binding lacks jurisdiction support", async () => {
        expect.assertions(1);

        const { shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });
        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", jurisdiction: "eu", shard });

        await expect(dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() })).rejects.toThrow(
            /does not support jurisdiction/,
        );
    });
});
