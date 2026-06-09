import { describe, expect, it } from "vitest";

import type { HttpActionCtx as HttpActionContext } from "../src/index";
import { httpAction, httpRouter } from "../src/index";

const context = {} as HttpActionContext;

describe("httpAction", () => {
    it("hands the injected ctx and the raw request to the wrapped handler", async () => {
        expect.assertions(4);

        const seen: { ctx: HttpActionContext; method: string }[] = [];
        const app = httpRouter();

        app.all(
            "/echo",
            httpAction((actionContext, request) => {
                seen.push({ ctx: actionContext, method: request.method });

                return new Response(request.method);
            }),
        );

        const marker = { auth: "marker" } as unknown as HttpActionContext;
        const response = await app.fetch(new Request("https://x/echo", { method: "PATCH" }), { __cirrusCtx: marker });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("PATCH");
        expect(seen[0]!.ctx).toBe(marker);
        expect(seen[0]!.method).toBe("PATCH");
    });

    it("passes the raw Response through unchanged", async () => {
        expect.assertions(2);

        const app = httpRouter();

        app.post(
            "/raw",
            httpAction(() => Response.json({ ok: true }, { status: 202 })),
        );

        const response = await app.fetch(new Request("https://x/raw", { method: "POST" }), { __cirrusCtx: context });

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });
});

describe("httpRouter", () => {
    it("routes by method", async () => {
        expect.assertions(2);

        const app = httpRouter();

        app.get(
            "/r",
            httpAction(() => new Response("GET")),
        );
        app.post(
            "/r",
            httpAction(() => new Response("POST")),
        );

        const getResponse = await app.fetch(new Request("https://x/r"), { __cirrusCtx: context });

        await expect(getResponse.text()).resolves.toBe("GET");

        const postResponse = await app.fetch(new Request("https://x/r", { method: "POST" }), { __cirrusCtx: context });

        await expect(postResponse.text()).resolves.toBe("POST");
    });

    it("returns hono's 404 for an unmatched path", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.get(
            "/known",
            httpAction(() => new Response("ok")),
        );

        const response = await app.fetch(new Request("https://x/unknown"), { __cirrusCtx: context });

        expect(response.status).toBe(404);
    });

    it("a path-match with the wrong verb is a 404", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.get(
            "/thing",
            httpAction(() => new Response("ok")),
        );

        const response = await app.fetch(new Request("https://x/thing", { method: "POST" }), { __cirrusCtx: context });

        expect(response.status).toBe(404);
    });

    it("errors when the action context was not injected (router used outside the runtime)", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.get(
            "/known",
            httpAction(() => new Response("ok")),
        );

        const response = await app.fetch(new Request("https://x/known"), {});

        expect(response.status).toBe(500);
    });
});
