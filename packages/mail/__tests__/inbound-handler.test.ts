import { describe, expect, it, vi } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import type { ForwardableEmailMessageLike } from "../src/inbound/handler";
import { createInboundEmailHandler, dispatchToLunoraFunction } from "../src/inbound/handler";
import type { InboundEmail } from "../src/inbound/parse";

/** A parsed message fixture used by the handler tests (parsing is covered separately). */
const fixture: InboundEmail = {
    attachments: [],
    authentication: { dkim: [], dmarc: [], spf: [] },
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

    it("rejects a dispatch failure with a controlled reason rather than rethrowing", async () => {
        expect.assertions(3);

        // Default behaviour with NO `retain` sink configured: bounce, exactly as
        // before the durable hand-off existed. This was briefly a rethrow, on the
        // premise that throwing lets the platform redeliver. It does not:
        // Cloudflare documents no inbound redelivery, the email lifecycle has no
        // branch for a worker that threw, and an uncaught throw reaches the
        // sender as an opaque `521 Upstream error`. Both outcomes are permanent,
        // so the controlled one wins — and the reason must never carry internal
        // error text, since it is reflected to an untrusted sender.
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw new Error("shard 502");
            },
            parse: async () => fixture,
        });

        await expect(handler(message, {}, undefined)).resolves.toBeUndefined();
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
        expect(message.setReject).not.toHaveBeenCalledWith(expect.stringContaining("shard 502"));
    });

    it("hands a failed dispatch to a durable `retain` sink and ACCEPTS the message instead of bouncing", async () => {
        expect.assertions(4);

        // Regression: a transient dispatch failure (a two-second shard 502) used
        // to permanently bounce a legitimate email. Cloudflare has no
        // transient-reject API and no inbound redelivery, so the retry has to be
        // absorbed in-worker: hand the message to something durable and ACCEPT
        // the SMTP session, because the message is now owned rather than lost.
        const failure = new Error("shard 502");
        const retained: { email: InboundEmail; error: unknown }[] = [];
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw failure;
            },
            parse: async () => fixture,
            retain: (email, _context, error) => {
                retained.push({ email, error });
            },
        });

        await expect(handler(message, {}, undefined)).resolves.toBeUndefined();
        expect(message.setReject).not.toHaveBeenCalled();
        expect(retained).toHaveLength(1);
        expect(retained[0]).toStrictEqual({ email: fixture, error: failure });
    });

    it("bounces with the generic reason when the durable hand-off itself fails", async () => {
        expect.assertions(4);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw new Error("shard 502");
            },
            parse: async () => fixture,
            retain: async () => {
                throw new Error("queue binding is undefined");
            },
        });

        // Nothing durable owns the message, so we are back to a permanent bounce
        // — with a reason that reflects nothing, and both real errors in the log.
        await expect(handler(message, {}, undefined)).resolves.toBeUndefined();
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
        expect(message.setReject).not.toHaveBeenCalledWith(expect.stringContaining("queue binding"));
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("retain failed to take ownership"), expect.any(Error));

        consoleError.mockRestore();
    });

    it("does not hand a self-rejected (permanent) dispatch failure to `retain`", async () => {
        expect.assertions(2);

        // A dispatch that knows one of its own failures is permanent — a missing
        // Workflow binding, malformed input — rejects and returns rather than
        // throwing, so it must still bounce even with a durable sink configured.
        // Otherwise every undeliverable message is silently swallowed into a
        // queue that will never succeed.
        const retain = vi.fn<() => void>();
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async (_email, context) => {
                context.message.setReject("message could not be processed");
            },
            parse: async () => fixture,
            retain,
        });

        await handler(message, {}, undefined);

        expect(retain).not.toHaveBeenCalled();
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
    });

    it("rejects a parse failure with a generic reason (not internal error text)", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => undefined,
            parse: async () => {
                throw new Error("internal secret detail");
            },
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

    it("proceeds only on true/undefined — every other answer is a rejection", async () => {
        expect.assertions(6);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        // A hook is typed `boolean | void`, but it runs across an untyped boundary
        // (a JS project, a hook that forgot a branch and fell out of a `switch`).
        // A gate that only recognises literal `false` admits every one of these into
        // the privileged dispatch.
        for (const answer of [null, 0, ""]) {
            const dispatch = vi.fn<() => Promise<void>>(async () => undefined);
            const message = fakeMessage();
            const handler = createInboundEmailHandler({
                dispatch,
                parse: async () => fixture,
                verify: () => answer as unknown as boolean,
            });

            // eslint-disable-next-line no-await-in-loop -- one independent handler run per answer
            await handler(message, {}, undefined);

            expect(dispatch).not.toHaveBeenCalled();
            expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
        }

        consoleError.mockRestore();
    });

    it("still proceeds for a void hook that rejects by throwing", async () => {
        expect.assertions(1);

        const dispatch = vi.fn<() => Promise<void>>(async () => undefined);
        const handler = createInboundEmailHandler({
            dispatch,
            parse: async () => fixture,
            verify: () => {
                // A `(): void` hook that returns nothing is the documented "proceed".
            },
        });

        await handler(fakeMessage(), {}, undefined);

        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("calls a custom onError for a dispatch failure — for observability — then still rejects", async () => {
        expect.assertions(4);

        // Regression: narrowing `onError` to parse/verify meant an app that wired
        // error reporting into it saw NO dispatch failure at all — silent at build
        // time, blind at runtime. The hook is observability only; the message is
        // rejected with the generic reason regardless of what it does.
        const message = fakeMessage();
        const onError = vi.fn<() => void>();
        const failure = new Error("shard 502");
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw failure;
            },
            onError,
            parse: async () => fixture,
        });

        await expect(handler(message, {}, undefined)).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(failure, expect.objectContaining({ message }));
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
    });

    it("an onError that itself throws cannot mask the dispatch failure", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const message = fakeMessage();
        const handler = createInboundEmailHandler({
            dispatch: async () => {
                throw new Error("shard 502");
            },
            onError: () => {
                throw new Error("sentry is down");
            },
            parse: async () => fixture,
        });

        // A broken reporting hook must not change the outcome: the message is
        // still rejected with the generic reason, and the hook's own failure is
        // logged rather than replacing the dispatch failure.
        await expect(handler(message, {}, undefined)).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onError threw"), expect.any(Error));

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

    /**
     * Mirrors the generated shard's `handleRpc` visibility gate: an `internal`
     * target answers `FUNCTION_NOT_FOUND` unless the dispatch is marked system
     * (`x-lunora-system: "1"`) — the marker a client RPC can never carry.
     */
    const stubVisibilityGatedShard = (visibility: "internal" | "public") => {
        type GatedFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ json: () => Promise<unknown>; ok: boolean }>;

        const fetch = vi.fn<GatedFetch>(async (_url, init) => {
            const denied = visibility === "internal" && init?.headers?.["x-lunora-system"] !== "1";

            return {
                json: async () => (denied ? { error: { code: "FUNCTION_NOT_FOUND", message: "function not registered: inbound:onEmail" } } : { result: "ok" }),
                ok: true,
            };
        });

        return {
            fetch,
            shard: {
                get: () => {
                    return { fetch };
                },
                idFromName: (name: string) => `id:${name}`,
            },
        };
    };

    it("marks the dispatch a trusted system call, not an anonymous bearer RPC", async () => {
        expect.assertions(2);

        const { fetch, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard });

        await dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        const [, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];

        expect(init.headers["x-lunora-system"]).toBe("1");
        expect(init.headers.authorization).toBe("Bearer secret");
    });

    it("reaches an internal target, and still reaches a public one", async () => {
        expect.assertions(2);

        const context = { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() };
        const internalShard = stubVisibilityGatedShard("internal");
        const publicShard = stubVisibilityGatedShard("public");

        await expect(dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard: internalShard.shard })(fixture, context)).resolves.toBeUndefined();
        await expect(dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard: publicShard.shard })(fixture, context)).resolves.toBeUndefined();
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

    it("wire-encodes the envelope args so a custom resolveArgs can return a bigint/Date", async () => {
        expect.assertions(3);

        // The shard decodes `args` on BOTH arms this envelope can reach — the
        // ordinary function dispatch (`decodeWire(payload.args)`) and the reserved
        // `__lunora_admin__:*` ops (`decodeAdminArgs`) — so the producer has to
        // encode or the hop is asymmetric. The default `resolveArgs` is
        // `toJsonSafeEmail`, which is already pure JSON (attachment bytes are
        // base64'd), so only a caller-supplied override was exposed: a `bigint`
        // threw in `JSON.stringify` and a `Date` arrived as an ISO string.
        const receivedAt = new Date("2026-06-01T12:00:00.000Z");
        const { fetch, shard } = stubShard({
            json: async () => {
                return { result: "ok" };
            },
            ok: true,
        });

        const dispatch = dispatchToLunoraFunction({
            functionPath: "inbound:onEmail",
            resolveArgs: () => {
                return { receivedAt, sizeBytes: 9_007_199_254_740_993n };
            },
            shard,
        });

        await dispatch(fixture, { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: fakeMessage() });

        const [, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
        const envelope = JSON.parse(init.body) as { args: unknown; functionPath: string };
        const decoded = decodeWire(envelope.args) as { receivedAt: unknown; sizeBytes: unknown };

        expect(envelope.functionPath).toBe("inbound:onEmail");
        expect(decoded.sizeBytes).toBe(9_007_199_254_740_993n);
        expect(decoded.receivedAt).toStrictEqual(receivedAt);
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

    it("end-to-end: a shard error bounces with a generic reason, never leaking the shard's text", async () => {
        expect.assertions(3);

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

        // A shard fault IS transient, but this app wired no `retain` sink, and
        // Cloudflare gives an inbound worker no way to say "try later" — both a
        // throw and a `setReject` are permanent to the sender, so the handler
        // picks the one whose reason it controls. Configure `retain` to absorb
        // the retry in-worker instead; see the handler's note.
        await expect(handler(message, { LUNORA_ADMIN_TOKEN: "secret" }, undefined)).resolves.toBeUndefined();
        expect(message.setReject).toHaveBeenCalledWith("message could not be processed");
        expect(message.setReject).not.toHaveBeenCalledWith(expect.stringContaining("returned an error"));
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
