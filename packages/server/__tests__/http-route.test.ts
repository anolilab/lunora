import { describe, expect, expectTypeOf, it } from "vitest";

import type { HttpActionCtx as HttpActionContext, LunoraRouteHandler } from "../src/index";
import { httpRoute, httpRouter, LunoraError, v } from "../src/index";

const context = {} as HttpActionContext;

/** Mount a built route on a fresh hono app at `method path` and dispatch `request` with an injected ctx. */
const dispatch = async (route: LunoraRouteHandler, method: string, path: string, request: Request): Promise<Response> => {
    const app = httpRouter();

    app.on(method, path, route);

    return app.fetch(request, { __lunoraCtx: context });
};

describe("httpRoute terminal shape", () => {
    it("yields a hono handler mountable on httpRouter", async () => {
        expect.assertions(2);

        const route = httpRoute.get("/api/ping").handler(() => {
            return { ok: true };
        });

        expectTypeOf(route).toBeFunction();

        const response = await dispatch(route, "GET", "/api/ping", new Request("https://x/api/ping"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });
});

describe("httpRoute searchParams", () => {
    it("coerces query strings to the declared scalar types and hands the handler a typed object", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ active: v.boolean(), limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?limit=5&active=true"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ active: true, limit: 5 });
    });

    it("an absent optional param is omitted; a present one is decoded", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ q: v.optional(v.string()) })
            .handler(({ searchParams }) => {
                return { keys: Object.keys(searchParams), value: searchParams.q ?? null };
            });

        const emptyResponse = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items"));

        await expect(emptyResponse.json()).resolves.toEqual({ keys: [], value: null });

        const queryResponse = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?q=hi"));

        await expect(queryResponse.json()).resolves.toEqual({
            keys: ["q"],
            value: "hi",
        });
    });

    it("collects repeated params into an array validator", async () => {
        expect.assertions(1);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ tag: v.array(v.string()) })
            .handler(({ searchParams }) => searchParams.tag);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?tag=a&tag=b"));

        await expect(response.json()).resolves.toEqual(["a", "b"]);
    });

    it("a malformed scalar fails with a 400 naming the field", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?limit=abc"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST", error: expect.stringContaining("searchParams.limit") });
    });

    it("an empty-but-present numeric param fails with a 400 (not coerced to 0)", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        // `Number("")` is `0`; without the empty-string guard `?limit=` would
        // silently satisfy `v.number()` as 0 instead of being rejected.
        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items?limit="));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST", error: expect.stringContaining("searchParams.limit") });
    });

    it("a missing required param fails with a 400", async () => {
        expect.assertions(1);

        const route = httpRoute
            .get("/api/items")
            .searchParams({ limit: v.number() })
            .handler(({ searchParams }) => searchParams);

        const response = await dispatch(route, "GET", "/api/items", new Request("https://x/api/items"));

        expect(response.status).toBe(400);
    });
});

describe("httpRoute params", () => {
    it("coerces and validates a typed path param", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/api/users/:id")
            .params({ id: v.number() })
            .handler(({ params }) => {
                return { id: params.id };
            });

        const response = await dispatch(route, "GET", "/api/users/:id", new Request("https://x/api/users/42"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ id: 42 });
    });

    it("a malformed path param fails with a 400 naming the field", async () => {
        expect.assertions(2);

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
    it("validates the JSON body and exposes it typed to the handler", async () => {
        expect.assertions(2);

        const route = httpRoute
            .post("/api/todos")
            .body({ text: v.string() })
            .handler(({ body }) => {
                return { created: body.text };
            });

        const response = await dispatch(
            route,
            "POST",
            "/api/todos",
            new Request("https://x/api/todos", { body: JSON.stringify({ text: "buy milk" }), method: "POST" }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ created: "buy milk" });
    });

    it("rejects a non-JSON body with a 400", async () => {
        expect.assertions(2);

        const route = httpRoute
            .post("/api/todos")
            .body({ text: v.string() })
            .handler(({ body }) => body);

        const response = await dispatch(route, "POST", "/api/todos", new Request("https://x/api/todos", { body: "not json", method: "POST" }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
    });

    it("a body field that violates its validator fails with a 400 naming the field", async () => {
        expect.assertions(2);

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
    it("parses the result through .output(), stripping undeclared keys before serialization", async () => {
        expect.assertions(1);

        const route = httpRoute
            .get("/api/me")
            .output(v.object({ id: v.string() }))
            .handler(() => ({ id: "u1", secret: "leaked" }) as { id: string });

        const response = await dispatch(route, "GET", "/api/me", new Request("https://x/api/me"));

        await expect(response.json()).resolves.toEqual({ id: "u1" });
    });

    it("a result that violates .output() surfaces as a 500, not a 400", async () => {
        expect.assertions(3);

        const route = httpRoute
            .get("/api/me")
            .output(v.object({ id: v.string() }))
            .handler(() => ({ id: 123 }) as unknown as { id: string });

        const response = await dispatch(route, "GET", "/api/me", new Request("https://x/api/me"));
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(500);
        expect(body).toMatchObject({ code: "INTERNAL_SERVER_ERROR", error: "Internal error" });
        expect(body.error).not.toContain("Response did not match the declared output schema");
    });
});

describe("httpRoute error redaction", () => {
    it("an internal-coded thrown LunoraError is redacted to a generic message on the wire", async () => {
        expect.assertions(3);

        const route = httpRoute.get("/api/boom").handler(() => {
            throw new LunoraError("INTERNAL_SERVER_ERROR", "leaky details");
        });

        const response = await dispatch(route, "GET", "/api/boom", new Request("https://x/api/boom"));
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(500);
        expect(body).toEqual({ code: "INTERNAL_SERVER_ERROR", error: "Internal error" });
        expect(body.error).not.toContain("leaky details");
    });

    it("a non-internal thrown LunoraError still echoes its message", async () => {
        expect.assertions(2);

        const route = httpRoute.get("/api/bad").handler(() => {
            throw new LunoraError("BAD_REQUEST", "user-facing reason");
        });

        const response = await dispatch(route, "GET", "/api/bad", new Request("https://x/api/bad"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ code: "BAD_REQUEST", error: "user-facing reason" });
    });
});

describe("httpRoute composition", () => {
    it("searchParams, body, and output compose regardless of declaration order", async () => {
        expect.assertions(2);

        const route = httpRoute
            .post("/api/search")
            .output(v.object({ echo: v.string(), page: v.number() }))
            .searchParams({ page: v.number() })
            .body({ query: v.string() })
            .handler(({ body, searchParams }) => {
                return { echo: body.query, page: searchParams.page };
            });

        const response = await dispatch(
            route,
            "POST",
            "/api/search",
            new Request("https://x/api/search?page=2", { body: JSON.stringify({ query: "cats" }), method: "POST" }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ echo: "cats", page: 2 });
    });

    it("a handler returning undefined with no .output() yields 204 No Content", async () => {
        expect.assertions(2);

        const route = httpRoute.post("/api/noop").handler(() => undefined);

        const response = await dispatch(route, "POST", "/api/noop", new Request("https://x/api/noop", { method: "POST" }));

        expect(response.status).toBe(204);
        await expect(response.text()).resolves.toBe("");
    });

    it("passes the action ctx through to the handler", async () => {
        expect.assertions(1);

        const seen: HttpActionContext[] = [];
        const route = httpRoute.get("/api/ctx").handler((options) => {
            seen.push(options.ctx);

            return { ok: true };
        });

        const marker = { auth: "marker" } as unknown as HttpActionContext;
        const app = httpRouter();

        app.get("/api/ctx", route);
        await app.fetch(new Request("https://x/api/ctx"), { __lunoraCtx: marker });

        expect(seen[0]).toBe(marker);
    });

    it("attaches Cache-Control, Cache-Tag, and Vary headers when declared on the route", async () => {
        expect.assertions(4);

        const route = httpRoute
            .get("/api/products/:id")
            .params({ id: v.string() })
            .cacheControl("public, max-age=300")
            .cacheTag("products")
            .vary("Accept-Encoding")
            .handler(({ params }) => {
                return { id: params.id };
            });

        const response = await dispatch(route, "GET", "/api/products/:id", new Request("https://x/api/products/123"));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=300");
        expect(response.headers.get("cache-tag")).toBe("products");
        expect(response.headers.get("vary")).toBe("Accept-Encoding");
    });

    it("attaches cache headers on a 204 No Content response", async () => {
        expect.assertions(4);

        const route = httpRoute
            .delete("/api/cache")
            .cacheControl("private, no-store")
            .cacheTag("session")
            .handler(() => undefined);

        const response = await dispatch(route, "DELETE", "/api/cache", new Request("https://x/api/cache", { method: "DELETE" }));

        expect(response.status).toBe(204);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("cache-tag")).toBe("session");
        await expect(response.text()).resolves.toBe("");
    });
});
