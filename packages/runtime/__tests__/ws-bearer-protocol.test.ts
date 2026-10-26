import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../../shared/base64";
import { decodeBearerProtocol, encodeBearerProtocol } from "../../../shared/ws-bearer-protocol";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const WS_URL = "https://app.example/_lunora/ws";

const bearerProtocol = encodeBearerProtocol;

/** A `lunora.bearer.*` entry whose payload is arbitrary bytes, as a hostile client could send. */
const rawBearerProtocol = (text: string): string => `lunora.bearer.${toBase64Url(new TextEncoder().encode(text))}`;

/** A shard stub recording the upgrade it was forwarded (`undici` cannot build a 101, so it answers 200). */
const recordingShard = (): { forwarded: Request[]; namespace: ShardNamespaceLike } => {
    const forwarded: Request[] = [];
    const stub = {
        fetch: async (request: Request): Promise<Response> => {
            forwarded.push(request);

            return new Response("upgraded", { status: 200 });
        },
    };

    return {
        forwarded,
        namespace: {
            get: () => stub,
            idFromName: (name) => {
                return { __name: name };
            },
        },
    };
};

/** Resolves `Bearer user:<id>` to `{ userId: id }`, reading only `Authorization` — like a JWT resolver. */
const resolveIdentity = (request: Request): { userId: string } | null => {
    const match = /^Bearer user:(.+)$/u.exec(request.headers.get("authorization") ?? "");

    return match?.[1] === undefined ? null : { userId: match[1] };
};

const upgrade = async (headers: Record<string, string>): Promise<Request> => {
    const { forwarded, namespace } = recordingShard();
    const worker = createWorker({ resolveIdentity, shardDO: namespace });
    const response = await worker.fetch(new Request(WS_URL, { headers: { upgrade: "websocket", ...headers } }), {}, fakeContext);

    expect(response.status).toBe(200);

    expect(forwarded).toHaveLength(1);

    return forwarded[0] as Request;
};

describe("ws upgrade — bearer offered as a Sec-WebSocket-Protocol", () => {
    it("decodes the lunora.bearer subprotocol", () => {
        expect.assertions(3);

        expect(decodeBearerProtocol(bearerProtocol("eyJ.a-b_c.sig"))).toBe("eyJ.a-b_c.sig");
        expect(decodeBearerProtocol("lunora")).toBeUndefined();
        expect(decodeBearerProtocol("lunora.bearer.%%%")).toBeUndefined();
    });

    it("refuses a bearer that could not be an Authorization header value", () => {
        expect.assertions(4);

        expect(decodeBearerProtocol(rawBearerProtocol("user:alice\nx-lunora-userid: admin"))).toBeUndefined();
        expect(decodeBearerProtocol(rawBearerProtocol("user:\u0100lice"))).toBeUndefined();
        expect(decodeBearerProtocol(rawBearerProtocol("user alice"))).toBeUndefined();
        expect(decodeBearerProtocol(rawBearerProtocol("user:alice"))).toBe("user:alice");
    });

    it("answers a malformed bearer subprotocol anonymously instead of failing the upgrade", async () => {
        expect.assertions(3);

        const forwarded = await upgrade({ "sec-websocket-protocol": `lunora, ${rawBearerProtocol("user:\u0100lice")}` });

        expect(forwarded.headers.get("x-lunora-userid")).toBeNull();
    });

    it("hands resolveIdentity the execution context on the bearer path", async () => {
        expect.assertions(3);

        const { forwarded, namespace } = recordingShard();
        const seen: (ExecutionContextLike | undefined)[] = [];
        const worker = createWorker({
            resolveIdentity: (request, _env, context) => {
                seen.push(context);

                return resolveIdentity(request);
            },
            shardDO: namespace,
        });

        await worker.fetch(
            new Request(WS_URL, { headers: { "sec-websocket-protocol": `lunora, ${bearerProtocol("user:alice")}`, upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(seen).toStrictEqual([fakeContext]);
        expect(forwarded[0]?.headers.get("x-lunora-userid")).toBe("alice");
        expect(forwarded).toHaveLength(1);
    });

    it("authenticates the socket's user from the subprotocol bearer and strips it before the shard", async () => {
        expect.assertions(5);

        const forwarded = await upgrade({ "sec-websocket-protocol": `lunora, ${bearerProtocol("user:alice")}` });

        expect(forwarded.headers.get("x-lunora-userid")).toBe("alice");
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe("lunora");
        // The bearer is a USER credential: it never reaches the shard's `LUNORA_WS_BEARER` / admin header checks.
        expect(forwarded.headers.get("authorization")).toBeNull();
    });

    it("prefers a real Authorization header (a native client) over the subprotocol", async () => {
        expect.assertions(3);

        const forwarded = await upgrade({ authorization: "Bearer user:native", "sec-websocket-protocol": `lunora, ${bearerProtocol("user:alice")}` });

        expect(forwarded.headers.get("x-lunora-userid")).toBe("native");
    });

    it("stays anonymous without a bearer subprotocol", async () => {
        expect.assertions(4);

        const forwarded = await upgrade({ "sec-websocket-protocol": "lunora" });

        expect(forwarded.headers.get("x-lunora-userid")).toBeNull();
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe("lunora");
    });
});
