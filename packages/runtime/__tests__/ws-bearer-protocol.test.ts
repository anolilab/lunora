import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../../shared/base64";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { subprotocolBearer } from "../src/ws-bearer-protocol";

const fakeContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const WS_URL = "https://app.example/_lunora/ws";

const bearerProtocol = (token: string): string => `lunora.bearer.${toBase64Url(new TextEncoder().encode(token))}`;

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

    await worker.fetch(new Request(WS_URL, { headers: { upgrade: "websocket", ...headers } }), {}, fakeContext);

    expect(forwarded).toHaveLength(1);

    return forwarded[0] as Request;
};

describe("ws upgrade — bearer offered as a Sec-WebSocket-Protocol", () => {
    it("decodes the lunora.bearer subprotocol", () => {
        expect.assertions(3);

        const request = (protocol: string): Request => new Request(WS_URL, { headers: { "sec-websocket-protocol": protocol } });

        expect(subprotocolBearer(request(`lunora, ${bearerProtocol("eyJ.a-b_c.sig")}`))).toBe("eyJ.a-b_c.sig");
        expect(subprotocolBearer(request("lunora"))).toBeUndefined();
        expect(subprotocolBearer(request("lunora, lunora.bearer.%%%"))).toBeUndefined();
    });

    it("authenticates the socket's user from the subprotocol bearer and strips it before the shard", async () => {
        expect.assertions(4);

        const forwarded = await upgrade({ "sec-websocket-protocol": `lunora, ${bearerProtocol("user:alice")}` });

        expect(forwarded.headers.get("x-lunora-userid")).toBe("alice");
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe("lunora");
        // The bearer is a USER credential: it never reaches the shard's `LUNORA_WS_BEARER` / admin header checks.
        expect(forwarded.headers.get("authorization")).toBeNull();
    });

    it("prefers a real Authorization header (a native client) over the subprotocol", async () => {
        expect.assertions(2);

        const forwarded = await upgrade({ authorization: "Bearer user:native", "sec-websocket-protocol": `lunora, ${bearerProtocol("user:alice")}` });

        expect(forwarded.headers.get("x-lunora-userid")).toBe("native");
    });

    it("stays anonymous without a bearer subprotocol", async () => {
        expect.assertions(3);

        const forwarded = await upgrade({ "sec-websocket-protocol": "lunora" });

        expect(forwarded.headers.get("x-lunora-userid")).toBeNull();
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe("lunora");
    });
});
