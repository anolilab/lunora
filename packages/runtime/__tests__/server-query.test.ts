import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeIdentityHeader } from "../../../shared/identity-header";
import type { ExecutionContextLike, ResolvedIdentity, ShardCaller } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * Records every forwarded request and echoes the function path, args, and the
 * identity headers the worker derived back as a JSON `{ result }` body. That
 * lets a test assert the in-process `serverQuery` fast-path produces a
 * BYTE-IDENTICAL response to the HTTP `/_lunora/rpc` path (PLAN4 §5.3): if the
 * two paths thread identity / shardKey / args identically, the echoed bodies
 * match exactly.
 */
interface EchoShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
}

const createEchoShardSpy = (): EchoShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];

    const spy = { calls } as EchoShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    // Record the forwarded request (header asserts read it) before
                    // draining the body below.
                    calls.push({ request, shardKey });

                    const body: { args?: unknown; functionPath?: unknown } = await request.json();

                    // Echo exactly what the shard "saw": the dispatched function,
                    // its args, the resolved shardKey, and the forwarded identity.
                    const result = {
                        args: body.args ?? {},
                        functionPath: body.functionPath,
                        identity: request.headers.get("x-lunora-identity"),
                        shardKey,
                        userId: request.headers.get("x-lunora-userid"),
                    };

                    return Response.json({ result }, { headers: { "content-type": "application/json" }, status: 200 });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A generated-`api`-shaped function reference (`{ __lunoraRef }`). */
const messagesList = { __lunoraRef: "messages:list" } as const;

/** Build the HTTP `/_lunora/rpc` request the client would post. */
const rpcRequest = (envelope: Record<string, unknown>, headers: Record<string, string> = {}): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify(envelope),
        headers,
        method: "POST",
    });

describe("serverQuery — in-process fast-path (PLAN4 §2.2 / §5.3)", () => {
    let shard: EchoShardSpy;

    beforeEach(() => {
        shard = createEchoShardSpy();
    });

    it("returns the SAME body as the HTTP path for an anonymous request", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: shard.namespace });

        // HTTP `/_lunora/rpc` path.
        const httpRes = await worker.fetch(rpcRequest({ args: { limit: 5 }, functionPath: "messages:list" }), {}, fakeContext);
        const httpBody = await httpRes.text();

        // In-process `serverQuery` off the same inbound request.
        const inProcessRes = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, { limit: 5 });
        const inProcessBody = await inProcessRes.text();

        expect(httpBody).toBe(inProcessBody);
        expect(JSON.parse(inProcessBody)).toEqual({
            result: { args: { limit: 5 }, functionPath: "messages:list", identity: null, shardKey: "__root__", userId: null },
        });
        // Both paths hit the default shard once each.
        expect(shard.calls.map((call) => call.shardKey)).toEqual(["__root__", "__root__"]);
    });

    it("returns the SAME body as the HTTP path for an authenticated request (forwarded cookie/identity)", async () => {
        expect.assertions(3);

        /** @returns the resolved identity for the request, or `null` when anonymous. */
        const resolveIdentity = (request: Request): null | ResolvedIdentity => {
            // Identity is derived from the forwarded cookie, exactly as a
            // better-auth session middleware would on both paths.
            const cookie = request.headers.get("cookie");

            if (cookie === "session=abc") {
                return { email: "u@example.com", userId: "user_42" };
            }

            return null;
        };

        const worker = createWorker({ resolveIdentity, shardDO: shard.namespace });

        // A browser POST always carries a same-origin `Origin`; include it so
        // the secure-by-default CSRF guard admits this cookie-authenticated RPC.
        const authedHeaders = { cookie: "session=abc", origin: "https://app.example" };

        const httpRes = await worker.fetch(rpcRequest({ args: {}, functionPath: "messages:list" }, authedHeaders), {}, fakeContext);
        const httpBody = await httpRes.text();

        const inProcessRes = await worker.serverQuery(new Request("https://app.example/page", { headers: authedHeaders }), {}, messagesList, {});
        const inProcessBody = await inProcessRes.text();

        expect(httpBody).toBe(inProcessBody);
        expect(JSON.parse(inProcessBody)).toEqual({
            result: {
                args: {},
                functionPath: "messages:list",
                identity: encodeIdentityHeader({ email: "u@example.com" }),
                shardKey: "__root__",
                userId: "user_42",
            },
        });
        // The forwarded cookie reached the shard on the in-process path too.
        expect(shard.calls[1]!.request.headers.get("x-lunora-userid")).toBe("user_42");
    });

    it("threads shardKey identically on both paths", async () => {
        expect.assertions(3);

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        const httpRes = await worker.fetch(rpcRequest({ args: {}, functionPath: "messages:list", shardKey: "channel-7" }), {}, fakeContext);
        const httpBody = await httpRes.text();

        const inProcessRes = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {}, { shardKey: "channel-7" });
        const inProcessBody = await inProcessRes.text();

        expect(httpBody).toBe(inProcessBody);
        expect(JSON.parse(inProcessBody)).toMatchObject({ result: { shardKey: "channel-7" } });
        expect(shard.calls.map((call) => call.shardKey)).toEqual(["channel-7", "channel-7"]);
    });

    it("rejects an unauthenticated call to an auth-gated function identically on both paths (RLS parity)", async () => {
        expect.assertions(5);

        // `authorizeShard` denies the anonymous caller — the same gate `handleRpc`
        // runs. If `serverQuery` bypassed it, this is where the divergence would show.
        const authorizeShard = vi.fn<(caller: ShardCaller) => boolean>(({ identity }) => identity !== null);

        const worker = createWorker({ authorizeShard, shardDO: shard.namespace });

        // Anonymous (no identity) → both paths must 403 with FORBIDDEN_SHARD.
        const httpRes = await worker.fetch(rpcRequest({ args: {}, functionPath: "messages:list", shardKey: "channel-7" }), {}, fakeContext);

        const inProcessRes = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {}, { shardKey: "channel-7" });

        expect(httpRes.status).toBe(403);
        expect(inProcessRes.status).toBe(403);
        await expect(httpRes.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_SHARD" } });
        await expect(inProcessRes.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_SHARD" } });
        // The gate ran before any shard dispatch on BOTH paths.
        expect(shard.calls).toHaveLength(0);
    });

    it("allows an authenticated call through the auth gate identically on both paths", async () => {
        expect.assertions(3);

        const authorizeShard = ({ identity }: ShardCaller): boolean => identity !== null;
        const resolveIdentity = (): ResolvedIdentity => {
            return { userId: "user_42" };
        };

        const worker = createWorker({ authorizeShard, resolveIdentity, shardDO: shard.namespace });

        const httpRes = await worker.fetch(rpcRequest({ args: {}, functionPath: "messages:list", shardKey: "channel-7" }), {}, fakeContext);
        const httpBody = await httpRes.text();

        const inProcessRes = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {}, { shardKey: "channel-7" });
        const inProcessBody = await inProcessRes.text();

        expect(httpRes.status).toBe(200);
        expect(httpBody).toBe(inProcessBody);
        expect(shard.calls).toHaveLength(2);
    });

    it("passes the resolved identity to authorizeShard the same way handleRpc does", async () => {
        expect.assertions(2);

        const authorizeShard = vi.fn<(caller: ShardCaller) => boolean>(() => true);
        const resolveIdentity = (): ResolvedIdentity => {
            return { email: "u@example.com", userId: "user_42" };
        };

        const worker = createWorker({ authorizeShard, resolveIdentity, shardDO: shard.namespace });

        await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {}, { shardKey: "channel-7" });

        expect(authorizeShard).toHaveBeenCalledTimes(1);
        // Full identity object (not just userId) + the resolved shardKey — exactly
        // the arguments the HTTP path passes.
        expect(authorizeShard).toHaveBeenCalledWith({ identity: { email: "u@example.com", userId: "user_42" }, shardKey: "channel-7" });
    });

    it("returns a BAD_REQUEST error Response (not a throw) for a non-reference, mirroring the HTTP catch", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.serverQuery(new Request("https://app.example/page"), {}, { notARef: true });

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("defaults shardKey to the worker's defaultShardKey when omitted", async () => {
        expect.assertions(2);

        const worker = createWorker({ defaultShardKey: "tenant-1", shardDO: shard.namespace });

        const res = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {});

        expect(JSON.parse(await res.text())).toMatchObject({ result: { shardKey: "tenant-1" } });
        expect(shard.calls[0]!.shardKey).toBe("tenant-1");
    });

    // An OTLP body past the gzip threshold is exported asynchronously, so without
    // the caller's `waitUntil` an SSR host can tear the isolate down mid-export and
    // silently lose exactly the error spans operators care about.
    it("registers dispatch telemetry with the caller's waitUntil", async () => {
        expect.assertions(2);

        const kept: Promise<unknown>[] = [];
        const observability = {
            onRpc: (_event: unknown, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => {
                context?.waitUntil?.(Promise.resolve("sent"));
            },
        };
        const worker = createWorker({ observability, shardDO: shard.namespace });

        await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {}, { waitUntil: (promise) => kept.push(promise) });

        expect(kept).toHaveLength(1);
        await expect(kept[0]).resolves.toBe("sent");
    });

    // Sinks are user-extensible and this context is fanned out to all of them, so
    // raw `env` (every secret binding) and the raw `Request` (its Authorization /
    // Cookie headers) must not be reachable from it.
    it("never exposes raw env or request to a sink", async () => {
        expect.assertions(3);

        const seen: object[] = [];
        const observability = {
            onRpc: (_event: unknown, context?: object) => {
                if (context) {
                    seen.push(context);
                }
            },
        };
        const worker = createWorker({ observability, shardDO: shard.namespace });

        await worker.serverQuery(new Request("https://app.example/page", { headers: { authorization: "Bearer hunter2" } }), { SECRET: "s3cret" }, messagesList);

        expect(seen).toHaveLength(1);
        expect(Object.keys(seen[0]!).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["resourceAttributes"]);
        expect(JSON.stringify(seen[0])).not.toContain("s3cret");
    });
});

describe("serverQuery — x402 paywall parity", () => {
    /** Structural shape of the injected `x402Charge` gate (the type is internal to create-worker). */
    type ChargeGateStub = (
        request: Request,
        spec: { functionPath: string; price: number | string },
        dispatch: () => Promise<Response>,
        deps?: { waitUntil?: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;

    const paidReport = { __lunoraRef: "reports:premium" } as const;
    const paidFunctions = { "reports:premium": { kind: "query", x402: { price: "$0.05" } } } as const;

    it("runs the charge gate and withholds the shard when unpaid", async () => {
        expect.assertions(4);

        // Before the fix `serverQuery` called `dispatchSingleShard` directly, so an
        // SSR loader served every paid result free: no 402, no settlement, while
        // the same procedure was paywalled over RPC and REST.
        const shard = createEchoShardSpy();
        const x402Charge = vi.fn<ChargeGateStub>(() => Promise.resolve(new Response(undefined, { status: 402 })));
        const worker = createWorker({ functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const response = await worker.serverQuery(new Request("https://app.example/page"), {}, paidReport, {});

        expect(response.status).toBe(402);
        expect(x402Charge).toHaveBeenCalledTimes(1);
        expect(x402Charge.mock.calls[0]![1]).toStrictEqual({ functionPath: "reports:premium", price: "$0.05" });
        expect(shard.calls).toHaveLength(0);
    });

    it("dispatches once the gate settles the payment", async () => {
        expect.assertions(2);

        const shard = createEchoShardSpy();
        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());
        const worker = createWorker({ functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const response = await worker.serverQuery(new Request("https://app.example/page"), {}, paidReport, {});

        expect(response.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
    });

    it("fail-closes a paid procedure with no gate configured (500), never serving it free", async () => {
        expect.assertions(2);

        const shard = createEchoShardSpy();
        const worker = createWorker({ functions: paidFunctions, shardDO: shard.namespace });

        const response = await worker.serverQuery(new Request("https://app.example/page"), {}, paidReport, {});

        expect(response.status).toBe(500);
        expect(shard.calls).toHaveLength(0);
    });

    it("leaves a free procedure untouched by the gate", async () => {
        expect.assertions(3);

        const shard = createEchoShardSpy();
        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());
        const worker = createWorker({ functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const response = await worker.serverQuery(new Request("https://app.example/page"), {}, messagesList, {});

        expect(response.status).toBe(200);
        expect(x402Charge).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });

    it("forwards the SSR host's `waitUntil` to the gate so the settlement receipt survives the response", async () => {
        expect.assertions(2);

        const shard = createEchoShardSpy();
        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());
        const worker = createWorker({ functions: paidFunctions, shardDO: shard.namespace, x402Charge });
        const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

        await worker.serverQuery(new Request("https://app.example/page"), {}, paidReport, {}, { waitUntil });

        const receipt = Promise.resolve();

        x402Charge.mock.calls[0]![3]!.waitUntil!(receipt);

        expect(waitUntil).toHaveBeenCalledWith(receipt);
        expect(shard.calls).toHaveLength(1);
    });
});

describe("reserved-prefix parity — the fan-out-only relation read is refused on every dispatch surface", () => {
    /**
     * `__lunora_relation__:*` reads RAW, RLS-blind rows for whatever `args.table`
     * names. The binding that pins `args.table` to the AUTHORIZED `fanOut.table`
     * lives in `parseEnvelope` and runs only when a `fanOut` is present, and the
     * DO applies no gate of its own — its comment cites the worker's refusal as
     * the reason ("worker refuses this prefix on a single-shard envelope, so it's
     * only reachable through the authorizeFanOut-gated fan-out path"). So the
     * guard being skipped on a surface means nothing checks it at all.
     */
    const relationRead = { __lunoraRef: "__lunora_relation__:read" } as const;

    it("serverQuery refuses it, byte-identically to /_lunora/rpc", async () => {
        expect.assertions(4);

        const shard = createEchoShardSpy();
        const worker = createWorker({ shardDO: shard.namespace });

        const httpRes = await worker.fetch(rpcRequest({ args: { table: "payments" }, functionPath: "__lunora_relation__:read" }), {}, fakeContext);
        const serverRes = await worker.serverQuery(
            new Request("https://app.example/loader"),
            {},
            relationRead,
            { table: "payments" },
            { context: fakeContext },
        );

        expect(httpRes.status).toBe(403);
        expect(serverRes.status).toBe(403);
        // `serverQuery`'s stated contract is a byte-identical result to the HTTP path.
        await expect(serverRes.text()).resolves.toBe(await httpRes.text());
        // Nothing reached a shard on either path.
        expect(shard.calls).toHaveLength(0);
    });

    it("an httpRoute's ctx.run* refuses it", async () => {
        expect.assertions(2);

        const shard = createEchoShardSpy();
        let thrown: unknown;

        const worker = createWorker({
            httpRouter: {
                fetch: async (_request: Request, env: unknown) => {
                    const ctx = (env as { __lunoraCtx: { runQuery: (reference: unknown, args: Record<string, unknown>) => Promise<unknown> } }).__lunoraCtx;

                    try {
                        await ctx.runQuery(relationRead, { table: "payments" });
                    } catch (error: unknown) {
                        thrown = error;
                    }

                    return new Response("ok");
                },
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(new Request("https://app.example/webhook", { method: "POST" }), {}, fakeContext);

        // `ctx.run*` additionally stamps `x-lunora-system: "1"`, so an unguarded
        // dispatch here reaches the shard as a TRUSTED caller.
        expect((thrown as { code?: string } | undefined)?.code).toBe("FORBIDDEN");
        expect(shard.calls).toHaveLength(0);
    });
});
