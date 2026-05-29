import { describe, expect, test } from "vitest";

import type { HttpActionCtx } from "../src/index.js";
import { httpAction, httpRouter } from "../src/index.js";

const ctx = {} as HttpActionCtx;

describe("httpAction", () => {
    test("hands the injected ctx and the raw request to the wrapped handler", async () => {
        const seen: { ctx: HttpActionCtx; method: string }[] = [];
        const app = httpRouter();

        app.all(
            "/echo",
            httpAction((actionCtx, request) => {
                seen.push({ ctx: actionCtx, method: request.method });

                return new Response(request.method);
            }),
        );

        const marker = { auth: "marker" } as unknown as HttpActionCtx;
        const response = await app.fetch(new Request("https://x/echo", { method: "PATCH" }), { __cirrusCtx: marker });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("PATCH");
        expect(seen[0]!.ctx).toBe(marker);
        expect(seen[0]!.method).toBe("PATCH");
    });

    test("passes the raw Response through unchanged", async () => {
        const app = httpRouter();

        app.post(
            "/raw",
            httpAction(() => Response.json({ ok: true }, { status: 202 })),
        );

        const response = await app.fetch(new Request("https://x/raw", { method: "POST" }), { __cirrusCtx: ctx });

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });
});

describe("httpRouter", () => {
    test("routes by method", async () => {
        const app = httpRouter();

        app.get(
            "/r",
            httpAction(() => new Response("GET")),
        );
        app.post(
            "/r",
            httpAction(() => new Response("POST")),
        );

        await expect((await app.fetch(new Request("https://x/r"), { __cirrusCtx: ctx })).text()).resolves.toBe("GET");
        await expect((await app.fetch(new Request("https://x/r", { method: "POST" }), { __cirrusCtx: ctx })).text()).resolves.toBe("POST");
    });

    test("returns hono's 404 for an unmatched path", async () => {
        const app = httpRouter();

        app.get(
            "/known",
            httpAction(() => new Response("ok")),
        );

        expect((await app.fetch(new Request("https://x/unknown"), { __cirrusCtx: ctx })).status).toBe(404);
    });

    test("a path-match with the wrong verb is a 404", async () => {
        const app = httpRouter();

        app.get(
            "/thing",
            httpAction(() => new Response("ok")),
        );

        expect((await app.fetch(new Request("https://x/thing", { method: "POST" }), { __cirrusCtx: ctx })).status).toBe(404);
    });

    test("errors when the action context was not injected (router used outside the runtime)", async () => {
        const app = httpRouter();

        app.get(
            "/known",
            httpAction(() => new Response("ok")),
        );

        expect((await app.fetch(new Request("https://x/known"), {})).status).toBe(500);
    });
});
