import type { ServerResponse } from "node:http";

import type { ViteDevServer } from "vite";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin } from "../src/dashboard-plugin.js";

describe("buildDashboardUrl", () => {
    it("prefers Vite's resolved local URL", () => {
        expect.assertions(2);

        expect(buildDashboardUrl({ resolvedLocal: "http://localhost:5173/" })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ resolvedLocal: "https://localhost:4000" })).toBe("https://localhost:4000/__cirrus");
    });

    it("falls back to the socket address, normalising the wildcard host", () => {
        expect.assertions(2);

        expect(buildDashboardUrl({ address: { address: "0.0.0.0", family: "IPv4", port: 5173 } })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ address: { address: "::", family: "IPv6", port: 4321 } })).toBe("http://localhost:4321/__cirrus");
    });

    it("brackets IPv6 hosts", () => {
        expect.assertions(1);

        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a local Vite dev server is plain http; asserting that is the point
        expect(buildDashboardUrl({ address: { address: "::1", family: "IPv6", port: 5173 } })).toBe("http://[::1]:5173/__cirrus");
    });

    it("honours a non-root base", () => {
        expect.assertions(1);

        expect(buildDashboardUrl({ address: { address: "127.0.0.1", family: "IPv4", port: 5173 }, base: "/app/" })).toBe("http://127.0.0.1:5173/app/__cirrus");
    });

    it("falls back to a default when the address is a pipe string or undefined", () => {
        expect.assertions(2);

        // eslint-disable-next-line sonarjs/publicly-writable-directories -- not a real path, just a stand-in for a named-pipe address string
        const pipe = "/tmp/vite.sock";

        expect(buildDashboardUrl({ address: pipe })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ address: undefined })).toBe("http://localhost:5173/__cirrus");
    });
});

describe("dashboardPlugin", () => {
    it("is a dev-only plugin with a configureServer hook", () => {
        // 2 runtime assertions; the expectTypeOf below is a compile-time check and isn't counted.
        expect.assertions(2);

        const plugin = dashboardPlugin();

        expect(plugin.name).toBe("cirrus:dashboard");
        expect(plugin.apply).toBe("serve");

        expectTypeOf(plugin.configureServer).not.toBeUndefined();
    });

    it("serves static dashboard HTML at /__cirrus and passes other paths through", () => {
        expect.assertions(7);

        const plugin = dashboardPlugin();
        let middleware: ((request: { url?: string }, response: ServerResponse, next: () => void) => void) | undefined;

        const server = {
            config: { base: "/", logger: { info: vi.fn<(message: string) => void>() } },
            httpServer: {
                address: () => {
                    return { address: "127.0.0.1", family: "IPv4", port: 5173 };
                },
                listening: true,
                once: vi.fn<() => void>(),
            },
            middlewares: {
                use: (function_: typeof middleware) => {
                    middleware = function_;
                },
            },
            resolvedUrls: { local: ["http://localhost:5173/"], network: [] },
        } as unknown as ViteDevServer;

        // configureServer returns a post-hook; invoking it prints the URL.
        const post = (plugin.configureServer as (s: ViteDevServer) => () => void)(server);

        expect(middleware).toBeDefined();

        // A non-dashboard path calls next() and writes nothing.
        const next = vi.fn<() => void>();
        const passthroughResponse = {
            end: vi.fn<(chunk?: string) => void>(),
            setHeader: vi.fn<(name: string, value: string) => void>(),
            statusCode: 0,
        } as unknown as ServerResponse;

        middleware?.({ url: "/src/main.tsx" }, passthroughResponse, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect((passthroughResponse as unknown as { end: ReturnType<typeof vi.fn> }).end).not.toHaveBeenCalled();

        // The dashboard path serves the static HTML verbatim — no transform, and
        // it points at the prebuilt static bundle, not a source module.
        const end = vi.fn<(chunk?: string) => void>();
        const dashResponse = { end, setHeader: vi.fn<(name: string, value: string) => void>(), statusCode: 0 } as unknown as ServerResponse;
        const dashNext = vi.fn<() => void>();

        middleware?.({ url: DASHBOARD_PATH }, dashResponse, dashNext);

        expect(dashNext).not.toHaveBeenCalled();
        expect(end).toHaveBeenCalledTimes(1);
        expect((end.mock.calls[0] as [string])[0]).toContain(`${DASHBOARD_PATH}/dashboard.js`);

        // The post-hook announces the dashboard URL.
        post();

        // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock on the fake server's logger; no `this` binding to lose
        expect(server.config.logger.info).toHaveBeenCalledWith(expect.stringContaining("/__cirrus"));
    });

    it("handles the static asset routes rather than passing them through", () => {
        expect.assertions(5);

        const middleware = installMiddleware("localhost");
        const next = vi.fn<() => void>();

        // Both the script and stylesheet routes are owned by the plugin. They
        // resolve to 200 when @cirrus/dashboard is built, or 501 when it isn't —
        // either way the request must not fall through to the next middleware.
        for (const url of [`${DASHBOARD_PATH}/dashboard.js`, `${DASHBOARD_PATH}/styles.css`]) {
            const { end, response } = makeResponse();

            middleware({ url }, response, next);

            expect([200, 501]).toContain(response.statusCode);
            expect(end).toHaveBeenCalledTimes(1);
        }

        expect(next).not.toHaveBeenCalled();
    });

    const installMiddleware = (configuredHost: unknown): ((request: { url?: string }, response: ServerResponse, next: () => void) => void) => {
        const plugin = dashboardPlugin();
        let middleware: ((request: { url?: string }, response: ServerResponse, next: () => void) => void) | undefined;

        const server = {
            config: { base: "/", logger: { info: vi.fn<(message: string) => void>(), warnOnce: vi.fn<(message: string) => void>() }, server: { host: configuredHost } },
            httpServer: { listening: false, once: vi.fn<() => void>() },
            middlewares: {
                use: (function_: typeof middleware) => {
                    middleware = function_;
                },
            },
            transformIndexHtml: vi.fn<(url: string, html: string) => Promise<string>>(async (_url: string, html: string) => html),
        } as unknown as ViteDevServer;

        (plugin.configureServer as (s: ViteDevServer) => unknown)(server);

        if (middleware === undefined) {
            throw new Error("middleware was not installed");
        }

        return middleware;
    };

    const makeResponse = (): { end: ReturnType<typeof vi.fn>; response: ServerResponse } => {
        const end = vi.fn<(chunk?: string) => void>();
        const response = { end, setHeader: vi.fn<(name: string, value: string) => void>(), statusCode: 0 } as unknown as ServerResponse;

        return { end, response };
    };

    it("returns 403 on a non-loopback bind", () => {
        expect.assertions(3);

        const middleware = installMiddleware("0.0.0.0");
        const { end, response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: DASHBOARD_PATH }, response, next);

        expect(response.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect((end.mock.calls[0] as [string])[0]).toContain("loopback");
    });

    it.each(["localhost", "127.0.0.1", "::1", undefined, false])("serves the dashboard when host is %s", async (host) => {
        expect.assertions(2);

        const middleware = installMiddleware(host);
        const { response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: DASHBOARD_PATH }, response, next);
        await Promise.resolve();
        await Promise.resolve();

        expect(response.statusCode).toBe(200);
        expect(next).not.toHaveBeenCalled();
    });

    it.each([`${DASHBOARD_PATH}?foo=1`, `${DASHBOARD_PATH}/`, `${DASHBOARD_PATH}/?foo=1`])("matches the dashboard route variant %s", async (url) => {
        expect.assertions(2);

        const middleware = installMiddleware("localhost");
        const { response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url }, response, next);
        await Promise.resolve();
        await Promise.resolve();

        expect(next).not.toHaveBeenCalled();
        expect(response.statusCode).toBe(200);
    });

    it.each([`${DASHBOARD_PATH}/globals`, `${DASHBOARD_PATH}/data`, `${DASHBOARD_PATH}/logs/123`])(
        "serves the SPA history fallback for deep-link sub-route %s (no 404)",
        (url) => {
            expect.assertions(3);

            // A hard load of a router sub-route must serve the document so the
            // client router can boot there — not pass through to a 404.
            const middleware = installMiddleware("localhost");
            const { end, response } = makeResponse();
            const next = vi.fn<() => void>();

            middleware({ url }, response, next);

            expect(next).not.toHaveBeenCalled();
            expect(response.statusCode).toBe(200);
            // It's the dashboard document, not an asset.
            expect((end.mock.calls[0] as [string])[0]).toContain(`${DASHBOARD_PATH}/dashboard.js`);
        },
    );
});
