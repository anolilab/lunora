/**
 * Spike 110 seam test. Proves the OpenNext custom-worker boundary:
 *   (a) a non-`/_lunora` request (a page) delegates to the OpenNext handler,
 *   (b) an RPC POST to `/_lunora/rpc` round-trips through Lunora,
 *   (c) admin routes reach Lunora,
 *   (d) a WebSocket upgrade to `/_lunora/ws` returns the 101 + its `webSocket`
 *       field VERBATIM — the exact thing a Next Route Handler + OpenNext response
 *       adapter would strip, which is why the WS path must live at the boundary.
 */
import { describe, expect, it, vi } from "vitest";

import type { FetchHost, LunoraHandler, ResponseLike } from "./compose-next-worker";
import { composeNextWorker } from "./compose-next-worker";

const makeOpenNextHost = (): FetchHost => ({
    fetch: vi.fn((request: Request): ResponseLike => new Response(`next-ssr:${new URL(request.url).pathname}`, { status: 200 })),
});

/** A stand-in for `createLunoraHandler()` covering the reserved sub-paths. */
const makeLunora = (socket: object): { calls: string[]; handler: LunoraHandler } => {
    const calls: string[] = [];

    const handler: LunoraHandler = (request) => {
        const { pathname } = new URL(request.url);

        calls.push(pathname);

        if (pathname === "/_lunora/ws" && request.headers.get("Upgrade") === "websocket") {
            // Cloudflare's WebSocket upgrade: a 101 whose `webSocket` field the
            // runtime hands to the client. Modelled as a plain object because Node's
            // `Response` constructor rejects status 101 (workerd allows it).
            return { status: 101, webSocket: socket };
        }

        if (pathname === "/_lunora/rpc") {
            return Response.json({ result: 42 });
        }

        if (pathname.startsWith("/_lunora/admin/")) {
            return Response.json({ admin: true });
        }

        return new Response("not found", { status: 404 });
    };

    return { calls, handler };
};

describe("spike 110: composeNextWorker OpenNext boundary seam", () => {
    it("delegates non-/_lunora requests to the OpenNext handler", async () => {
        const host = makeOpenNextHost();
        const { handler } = makeLunora({});
        const worker = composeNextWorker(host, handler);

        const response = (await worker.fetch(new Request("https://app.example/dashboard"), {})) as Response;

        expect(host.fetch).toHaveBeenCalledOnce();
        expect(await response.text()).toBe("next-ssr:/dashboard");
    });

    it("round-trips an RPC POST through Lunora without touching OpenNext", async () => {
        const host = makeOpenNextHost();
        const { handler } = makeLunora({});
        const worker = composeNextWorker(host, handler);

        const response = (await worker.fetch(new Request("https://app.example/_lunora/rpc", { body: "{}", method: "POST" }), {})) as Response;

        expect(host.fetch).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ result: 42 });
    });

    it("routes the admin plane to Lunora", async () => {
        const host = makeOpenNextHost();
        const { handler } = makeLunora({});
        const worker = composeNextWorker(host, handler);

        const response = (await worker.fetch(new Request("https://app.example/_lunora/admin/functions"), {})) as Response;

        expect(host.fetch).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ admin: true });
    });

    it("returns the WebSocket upgrade (101 + webSocket) verbatim at the boundary", async () => {
        const host = makeOpenNextHost();
        const socket = { id: "ws-1" };
        const { handler } = makeLunora(socket);
        const worker = composeNextWorker(host, handler);

        const response = (await worker.fetch(new Request("https://app.example/_lunora/ws", { headers: { Upgrade: "websocket" } }), {})) as {
            status: number;
            webSocket?: unknown;
        };

        expect(host.fetch).not.toHaveBeenCalled();
        expect(response.status).toBe(101);
        // The load-bearing assertion: the `webSocket` field survives the seam.
        expect(response.webSocket).toBe(socket);
    });
});
