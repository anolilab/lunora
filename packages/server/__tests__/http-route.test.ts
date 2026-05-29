import { describe, expect, expectTypeOf, test } from "vitest";

import type { CirrusRouteHandler, HttpActionCtx } from "../src/index.js";
import { httpRoute, httpRouter, v } from "../src/index.js";

const ctx = {} as HttpActionCtx;

/** Mount a built route on a fresh hono app at `method path` and dispatch `request` with an injected ctx. */
const dispatch = async (route: CirrusRouteHandler, method: string, path: string, request: Request): Promise<Response> => {
    const app = httpRouter();

    app.on(method, path, route);

    return app.fetch(request, { __cirrusCtx: ctx });
};

describe("httpRoute terminal shape", () => {
    test("yields a hono handler mountable on httpRouter", async () => {
        const route = httpRoute.get("/api/ping").handler(() => ({ ok: true }));

        expectTypeOf(route).toBeFunction();

        const response = await dispatch(route, "GET", "/api/ping", new Request("https://x/api/ping"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });
});

describe("httpRoute searchParams", () => {
    test("coerces query strings to the declared scalar types and hands the handler a typed object", async () => {
        const route = httpRoute
            .get("/api/items")
            .searchParams({ active: v.boolean(), limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?limit=5&active=true"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ active: true, limit: 5 });
    });

    test("an absent optional param is omitted; a present one is decoded", async () => {
        const route = httpRoute
            .get("/api/items")
            .searchParams({ q: v.optional(v.string()) })
            .handler(({ searchParams }) => ({ keys: Object.keys(searchParams), value: searchParams.q ?? null }));

        await expect((await dispatch(route, "GET", "/api/items", new Request("https://x/api/items"))).json()).resolves.toEqual({ keys: [], value: null });
        await expect((await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?q=hi"))).json()).resolves.toEqual({
            keys: ["q"],
            value: "hi",
        });
    });

    test("collects repeated params into an array validator", async () => {
        const route = httpRoute
            .get("/api/items")
            .searchParams({ tag: v.array(v.string()) })
            .handler(({ searchParams }) => searchParams.tag);

        await expect((await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?tag=a&tag=b"))).json()).resolves.toEqual(["a", "b"]);
    });

    test("a malformed scalar fails with a 400 naming the field", async () => {
        const route = httpRoute
            .get("/api/items")
            .searchParams({ limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?limit=abc"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST", error: expect.stringContaining("searchParams.limit") });
    });

    test("a missing required param fails with a 400", async () => {
        const route = httpRoute
            .get("/api/items")
            .searchParams({ limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        expect((await dispatch(route, "GET", "/api/items", new Request("https://x/api/items"))).status).toBe(400);
    });
});

describe("httpRoute params", () => {
    test("coerces and validates a typed path param", async () => {
        const route = httpRoute
            .get("/api/users/:id")
            .params({ id: v.number() })
            .handler(({ params }) => ({ id: params.id }));

        const response = await dispatch(route, "GET", "/api/users/:id", new Request("https://x/api/users/42"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ id: 42 });
    });

    test("a malformed path param fails with a 400 naming the field", async () => {
        const route = httpRoute
            .get("/api/users/:id")
            .params({ id: v.number() })
            .handler(({ params }) => params);

        const response = await dispatch(route, "GET", "/api/users/:id", new Request("https://x/api/users/not-a-number"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST", error: expect.stringContaining("params.id") });
    });
});

describe("httpRoute body", () => {
    test("validates the JSON body and exposes it typed to the handler", async () => {
        const route = httpRoute
            .post("/api/todos")
            .body({ text: v.string() })
            .handler(({ body }) => ({ created: body.text }));

        const response = await dispatch(
            route,
            "POST",
            "/api/todos",
            new Request("https://x/api/todos", { body: JSON.stringify({ text: "buy milk" }), method: "POST" }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ created: "buy milk" });
    });

    test("rejects a non-JSON body with a 400", async () => {
        const route = httpRoute
            .post("/api/todos")
            .body({ text: v.string() })
            .handler(({ body }) => body);

        const response = await dispatch(route, "POST", "/api/todos", new Request("https://x/api/todos", { body: "not json", method: "POST" }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
    });

    test("a body field that violates its validator fails with a 400 naming the field", async () => {
        const route = httpRoute
            .post("/api/todos")
            .body({ text: v.string() })
            .handler(({ body }) => body);

        const response = await dispatch(
            route,
            "POST",
            "/api/todos",
            new Request("https://x/api/todos", { body: JSON.stringify({ text: 42 }), method: "POST" }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("body.text") });
    });
});

describe("httpRoute output", () => {
    test("parses the result through .output(), stripping undeclared keys before serialization", async () => {
        const route = httpRoute
            .get("/api/me")
            .output(v.object({ id: v.string() }))
            .handler(() => ({ id: "u1", secret: "leaked" }) as { id: string });

        await expect((await dispatch(route, "GET", "/api/me", new Request("https://x/api/me"))).json()).resolves.toEqual({ id: "u1" });
    });

    test("a result that violates .output() surfaces as a 500, not a 400", async () => {
        const route = httpRoute
            .get("/api/me")
            .output(v.object({ id: v.string() }))
            .handler(() => ({ id: 123 }) as unknown as { id: string });

        const response = await dispatch(route, "GET", "/api/me", new Request("https://x/api/me"));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    });
});

describe("httpRoute composition", () => {
    test("searchParams, body, and output compose regardless of declaration order", async () => {
        const route = httpRoute
            .post("/api/search")
            .output(v.object({ echo: v.string(), page: v.number() }))
            .searchParams({ page: v.number() })
            .body({ query: v.string() })
            .handler(({ body, searchParams }) => ({ echo: body.query, page: searchParams.page }));

        const response = await dispatch(
            route,
            "POST",
            "/api/search",
            new Request("https://x/api/search?page=2", { body: JSON.stringify({ query: "cats" }), method: "POST" }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ echo: "cats", page: 2 });
    });

    test("a handler returning undefined with no .output() yields 204 No Content", async () => {
        const route = httpRoute.post("/api/noop").handler(() => undefined);

        const response = await dispatch(route, "POST", "/api/noop", new Request("https://x/api/noop", { method: "POST" }));

        expect(response.status).toBe(204);
        await expect(response.text()).resolves.toBe("");
    });

    test("passes the action ctx through to the handler", async () => {
        const seen: HttpActionCtx[] = [];
        const route = httpRoute.get("/api/ctx").handler((options) => {
            seen.push(options.ctx);

            return { ok: true };
        });

        const marker = { auth: "marker" } as unknown as HttpActionCtx;
        const app = httpRouter();

        app.get("/api/ctx", route);
        await app.fetch(new Request("https://x/api/ctx"), { __cirrusCtx: marker });

        expect(seen[0]).toBe(marker);
    });
});
