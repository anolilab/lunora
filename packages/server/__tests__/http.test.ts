import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

// The runtime's source, as codegen's tests import it: the end-to-end case needs both sides of the unrouted signal.
import { createWorker } from "../../runtime/src/create-worker";
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
        const response = await app.fetch(new Request("https://x/echo", { method: "PATCH" }), { __lunoraCtx: marker });

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

        const response = await app.fetch(new Request("https://x/raw", { method: "POST" }), { __lunoraCtx: context });

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("answers a thrown LunoraError with its status and code, as a typed route does", async () => {
        expect.assertions(2);

        const app = httpRouter();

        app.post(
            "/raw",
            httpAction(() => {
                throw new LunoraError("PAYLOAD_TOO_LARGE", "too big");
            }),
        );

        const response = await app.fetch(new Request("https://x/raw", { method: "POST" }), { __lunoraCtx: context });

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });

    it("still lets anything that is not a LunoraError escape to the host", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.post(
            "/raw",
            httpAction(() => {
                throw new TypeError("bug");
            }),
        );

        const response = await app.fetch(new Request("https://x/raw", { method: "POST" }), { __lunoraCtx: context });

        // hono's own fallback for an unhandled throw.
        expect(response.status).toBe(500);
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

        const getResponse = await app.fetch(new Request("https://x/r"), { __lunoraCtx: context });

        await expect(getResponse.text()).resolves.toBe("GET");

        const postResponse = await app.fetch(new Request("https://x/r", { method: "POST" }), { __lunoraCtx: context });

        await expect(postResponse.text()).resolves.toBe("POST");
    });

    it("returns hono's 404 for an unmatched path", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.get(
            "/known",
            httpAction(() => new Response("ok")),
        );

        const response = await app.fetch(new Request("https://x/unknown"), { __lunoraCtx: context });

        expect(response.status).toBe(404);
    });

    it("a path-match with the wrong verb is a 404", async () => {
        expect.assertions(1);

        const app = httpRouter();

        app.get(
            "/thing",
            httpAction(() => new Response("ok")),
        );

        const response = await app.fetch(new Request("https://x/thing", { method: "POST" }), { __lunoraCtx: context });

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

describe("httpRouter's not-found handler", () => {
    it("tells the runtime when no route matched, and not when a handler answers 404 itself", async () => {
        expect.assertions(4);

        const app = httpRouter();
        let unrouted = 0;
        const env = {
            __lunoraCtx: context,
            __lunoraUnrouted: () => {
                unrouted += 1;
            },
        };

        app.get(
            "/missing-row",
            httpAction(() => Response.json({ error: "NOT_FOUND" }, { status: 404 })),
        );

        const handled = await app.fetch(new Request("https://x/missing-row"), env);

        expect(handled.status).toBe(404);
        expect(unrouted).toBe(0);

        const missed = await app.fetch(new Request("https://x/nowhere"), env);

        // Hono's own not-found answer, unchanged.
        await expect(missed.text()).resolves.toBe("404 Not Found");
        expect(unrouted).toBe(1);
    });

    it("keeps a c.notFound() a handler or middleware returns on purpose a real 404, and still signals a miss behind global middleware", async () => {
        expect.assertions(5);

        const app = httpRouter();
        let unrouted = 0;
        const env = {
            __lunoraCtx: context,
            __lunoraUnrouted: () => {
                unrouted += 1;
            },
        };

        app.use("*", async (c, next) => {
            if (c.req.path.startsWith("/admin")) {
                return c.notFound();
            }

            await next();

            return undefined;
        });
        app.get("/records/:id", (c) => (c.req.header("authorization") === undefined ? c.notFound() : c.text("record")));

        const hidden = await app.fetch(new Request("https://x/records/1"), env);
        const denied = await app.fetch(new Request("https://x/admin/users"), env);

        expect(hidden.status).toBe(404);
        expect(denied.status).toBe(404);
        expect(unrouted).toBe(0);

        const missed = await app.fetch(new Request("https://x/nowhere"), env);

        expect(missed.status).toBe(404);
        expect(unrouted).toBe(1);
    });
});

describe("httpRouter behind a single-page app's worker", () => {
    it("answers a deliberate c.notFound() on a page navigation with 404, and a path no route matches with the shell", async () => {
        expect.assertions(4);

        const app = httpRouter();

        app.get("/api/records/:id", (c) => (c.req.header("authorization") === undefined ? c.notFound() : c.text("record")));

        const shell = "<!doctype html><div id=app></div>";
        const spaAssets = {
            // Under not_found_handling "single-page-application" the binding answers every missing path with the shell.
            fetch: async (request: Request) =>
                new Response(request.method === "HEAD" ? null : shell, { headers: { "content-type": "text/html", etag: '"shell"' } }),
        };
        const worker = createWorker({
            httpRouter: app,
            shardDO: {
                get: () => {
                    return { fetch: async () => Response.json({ result: null }) };
                },
                idFromName: (name: string) => {
                    return { __name: name };
                },
            },
            spaAssets,
        });
        const navigate = (path: string): Request => new Request(`https://app.test${path}`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
        const executionContext = { passThroughOnException: () => undefined, waitUntil: () => undefined };

        const denied = await worker.fetch(navigate("/api/records/1"), {}, executionContext);
        const page = await worker.fetch(navigate("/settings/profile"), {}, executionContext);

        expect(denied.status).toBe(404);
        await expect(denied.text()).resolves.toBe("404 Not Found");
        expect(page.status).toBe(200);
        await expect(page.text()).resolves.toBe(shell);
    });
});
