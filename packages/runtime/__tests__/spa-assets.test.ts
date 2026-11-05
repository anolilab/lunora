import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, HttpRouterLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import type { AssetsFetcherLike } from "../src/spa-assets";

const shardNamespace = (): ShardNamespaceLike => {
    return {
        get: () => {
            return { fetch: async () => Response.json({ result: null }) };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const SHELL = "<!doctype html><div id=app></div>";

/**
 * A Workers Static Assets binding under `not_found_handling: "single-page-application"`:
 * a file answers as itself, and any other path answers with `index.html` and a 200.
 */
const spaAssets = (): AssetsFetcherLike & { requests: Request[] } => {
    const files: Record<string, { body: string; etag: string; type: string }> = {
        "/favicon.ico": { body: "icon", etag: '"icon"', type: "image/x-icon" },
        "/privacy.html": { body: "<p>privacy</p>", etag: '"privacy"', type: "text/html" },
    };
    const requests: Request[] = [];

    return {
        fetch: async (request) => {
            requests.push(request);

            const file = files[new URL(request.url).pathname] ?? { body: SHELL, etag: '"shell"', type: "text/html" };

            return new Response(request.method === "HEAD" ? null : file.body, { headers: { "content-type": file.type, etag: file.etag } });
        },
        requests,
    };
};

/**
 * An `httpRouter()` app as the runtime sees it: its own not-found handler calls
 * `__lunoraUnrouted`, while a handler that answers 404 or 403 itself does not.
 */
const router: HttpRouterLike = {
    fetch: (request: Request, env: unknown) => {
        const { pathname } = new URL(request.url);

        if (pathname === "/webhooks/github" && request.method === "POST") {
            return new Response("hooked");
        }

        if (pathname === "/api/missing-row") {
            return Response.json({ error: "NOT_FOUND" }, { status: 404 });
        }

        if (pathname === "/api/secret") {
            return Response.json({ error: "FORBIDDEN" }, { status: 403 });
        }

        const { __lunoraUnrouted: markUnrouted } = env as { __lunoraUnrouted?: () => void };

        markUnrouted?.();

        return new Response("404 Not Found", { status: 404 });
    },
};

const navigate = (path: string, method = "GET"): Request =>
    new Request(`https://app.test${path}`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" }, method });

describe("createWorker — a single-page app's assets behind `/*`", () => {
    it("answers a page navigation no route serves with the app shell, carrying the Worker's security headers", async () => {
        expect.assertions(5);

        const assets = spaAssets();
        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: assets });
        const page = await worker.fetch(navigate("/settings/profile"), {}, fakeContext);
        const head = await worker.fetch(navigate("/settings/profile", "HEAD"), {}, fakeContext);

        expect(page.status).toBe(200);
        await expect(page.text()).resolves.toBe(SHELL);
        expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
        expect(head.status).toBe(200);
    });

    it("keeps the 404 for a fetch no route serves, where the binding could only answer with the shell", async () => {
        expect.assertions(2);

        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: spaAssets() });
        const response = await worker.fetch(new Request("https://app.test/api/typo", { headers: { accept: "application/json" } }), {}, fakeContext);

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.toBe("404 Not Found");
    });

    it("serves a real static file the Worker does not route, HTML included", async () => {
        expect.assertions(3);

        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: spaAssets() });
        const icon = await worker.fetch(new Request("https://app.test/favicon.ico"), {}, fakeContext);
        const privacy = await worker.fetch(new Request("https://app.test/privacy.html", { headers: { accept: "*/*" } }), {}, fakeContext);

        await expect(icon.text()).resolves.toBe("icon");
        expect(privacy.status).toBe(200);
        await expect(privacy.text()).resolves.toBe("<p>privacy</p>");
    });

    it("lets a webhook no route discovery sees reach its handler", async () => {
        expect.assertions(1);

        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: spaAssets() });
        const response = await worker.fetch(new Request("https://app.test/webhooks/github", { body: "{}", method: "POST" }), {}, fakeContext);

        await expect(response.text()).resolves.toBe("hooked");
    });

    it.each([["POST"], ["PUT"], ["PATCH"], ["DELETE"]])("keeps the 404 for a %s no route serves, without asking the assets", async (method) => {
        expect.assertions(2);

        const assets = spaAssets();
        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: assets });
        const response = await worker.fetch(navigate("/settings", method), {}, fakeContext);

        expect(response.status).toBe(404);
        expect(assets.requests).toHaveLength(0);
    });

    it.each([
        ["/api/missing-row", 404],
        ["/api/secret", 403],
    ])("keeps the %s a handler answered for a page navigation, without asking the assets", async (path, status) => {
        expect.assertions(3);

        const assets = spaAssets();
        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: assets });
        const response = await worker.fetch(navigate(path), {}, fakeContext);

        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(assets.requests).toHaveLength(0);
    });

    it("passes the request through unchanged, and reads the shell from the origin's root alone", async () => {
        expect.assertions(4);

        const assets = spaAssets();
        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace(), spaAssets: assets });
        const request = new Request("https://app.test/a/..%2f/index.html?x=1", { headers: { "if-none-match": '"shell"' } });

        await worker.fetch(request, {}, fakeContext);

        const [passed, shell] = assets.requests;

        expect(passed?.url).toBe(request.url);
        expect(passed?.headers.get("if-none-match")).toBe('"shell"');
        expect(shell?.url).toBe("https://app.test/");
        expect([...(shell?.headers.keys() ?? [])]).toStrictEqual([]);
    });

    it("keeps every miss a 404 without an assets binding", async () => {
        expect.assertions(1);

        const worker = createWorker({ httpRouter: router, shardDO: shardNamespace() });
        const response = await worker.fetch(navigate("/settings"), {}, fakeContext);

        expect(response.status).toBe(404);
    });

    it("never consults the assets for a router that does not say a miss is unrouted, as a framework host does", async () => {
        expect.assertions(2);

        const assets = spaAssets();
        const host: HttpRouterLike = { fetch: () => new Response("host 404", { status: 404 }) };
        const worker = createWorker({ httpRouter: host, shardDO: shardNamespace(), spaAssets: assets });
        const response = await worker.fetch(navigate("/settings"), {}, fakeContext);

        await expect(response.text()).resolves.toBe("host 404");
        expect(assets.requests).toHaveLength(0);
    });
});
