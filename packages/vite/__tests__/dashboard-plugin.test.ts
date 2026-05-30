import type { ServerResponse } from "node:http";

import type { ViteDevServer } from "vite";
import { describe, expect, test, vi } from "vitest";

import { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin } from "../src/dashboard-plugin.js";

describe("buildDashboardUrl", () => {
    test("prefers Vite's resolved local URL", () => {
        expect(buildDashboardUrl({ resolvedLocal: "http://localhost:5173/" })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ resolvedLocal: "https://localhost:4000" })).toBe("https://localhost:4000/__cirrus");
    });

    test("falls back to the socket address, normalising the wildcard host", () => {
        expect(buildDashboardUrl({ address: { address: "0.0.0.0", family: "IPv4", port: 5173 } })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ address: { address: "::", family: "IPv6", port: 4321 } })).toBe("http://localhost:4321/__cirrus");
    });

    test("brackets IPv6 hosts", () => {
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a local Vite dev server is plain http; asserting that is the point
        expect(buildDashboardUrl({ address: { address: "::1", family: "IPv6", port: 5173 } })).toBe("http://[::1]:5173/__cirrus");
    });

    test("honours a non-root base", () => {
        expect(buildDashboardUrl({ address: { address: "127.0.0.1", family: "IPv4", port: 5173 }, base: "/app/" })).toBe("http://127.0.0.1:5173/app/__cirrus");
    });

    test("falls back to a default when the address is a pipe string or null", () => {
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- not a real path, just a stand-in for a named-pipe address string
        const pipe = "/tmp/vite.sock";

        expect(buildDashboardUrl({ address: pipe })).toBe("http://localhost:5173/__cirrus");
        expect(buildDashboardUrl({ address: null })).toBe("http://localhost:5173/__cirrus");
    });
});

describe("dashboardPlugin", () => {
    test("is a dev-only plugin with a configureServer hook", () => {
        const plugin = dashboardPlugin();

        expect(plugin.name).toBe("cirrus:dashboard");
        expect(plugin.apply).toBe("serve");
        expect(typeof plugin.configureServer).toBe("function");
    });

    test("serves the dashboard HTML at /__cirrus and passes other paths through", async () => {
        const plugin = dashboardPlugin();
        let middleware: ((request: { url?: string }, response: ServerResponse, next: () => void) => void) | undefined;

        const server = {
            config: { base: "/", logger: { info: vi.fn() } },
            httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 5173 }), listening: true, once: vi.fn() },
            middlewares: {
                use: (fn: typeof middleware) => {
                    middleware = fn;
                },
            },
            resolvedUrls: { local: ["http://localhost:5173/"], network: [] },
            transformIndexHtml: vi.fn(async (_url: string, html: string) => html),
        } as unknown as ViteDevServer;

        // configureServer returns a post-hook; invoking it prints the URL.
        const post = (plugin.configureServer as (s: ViteDevServer) => () => void)(server);

        expect(middleware).toBeDefined();

        // A non-dashboard path calls next() and writes nothing.
        const next = vi.fn();
        const passthroughResponse = { end: vi.fn(), setHeader: vi.fn(), statusCode: 0 } as unknown as ServerResponse;

        middleware?.({ url: "/src/main.tsx" }, passthroughResponse, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect((passthroughResponse as unknown as { end: ReturnType<typeof vi.fn> }).end).not.toHaveBeenCalled();

        // The dashboard path serves transformed HTML.
        const end = vi.fn();
        const dashResponse = { end, setHeader: vi.fn(), statusCode: 0 } as unknown as ServerResponse;
        const dashNext = vi.fn();

        middleware?.({ url: DASHBOARD_PATH }, dashResponse, dashNext);
        await Promise.resolve();
        await Promise.resolve();

        expect(dashNext).not.toHaveBeenCalled();
        expect(server.transformIndexHtml).toHaveBeenCalled();
        expect(end).toHaveBeenCalledTimes(1);
        expect(String((end.mock.calls[0] as [string])[0])).toContain("@cirrus/dashboard/mount");

        // The post-hook announces the dashboard URL.
        post();

        expect(server.config.logger.info).toHaveBeenCalledWith(expect.stringContaining("/__cirrus"));
    });
});
