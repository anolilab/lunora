import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ViteDevServer } from "vite";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { buildStudioUrl, STUDIO_PATH, studioPlugin } from "../src/studio-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

/** The resolved plugin options the studio reads: its project root, schema dir and apiSpec. */
const makeOptions = (overrides: Partial<ResolvedLunoraPluginOptions> = {}): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: false,
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot: process.cwd(),
        schemaDir: "lunora",
        shard: {},
        studio: true,
        target: "cloudflare",
        validateWrangler: false,
        ...overrides,
    };
};

describe("buildStudioUrl", () => {
    it("prefers Vite's resolved local URL", () => {
        expect.assertions(2);

        expect(buildStudioUrl({ resolvedLocal: "http://localhost:5173/" })).toBe("http://localhost:5173/__lunora");
        expect(buildStudioUrl({ resolvedLocal: "https://localhost:4000" })).toBe("https://localhost:4000/__lunora");
    });

    it("falls back to the socket address, normalising the wildcard host", () => {
        expect.assertions(2);

        expect(buildStudioUrl({ address: { address: "0.0.0.0", family: "IPv4", port: 5173 } })).toBe("http://localhost:5173/__lunora");
        expect(buildStudioUrl({ address: { address: "::", family: "IPv6", port: 4321 } })).toBe("http://localhost:4321/__lunora");
    });

    it("brackets IPv6 hosts", () => {
        expect.assertions(1);

        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a local Vite dev server is plain http; asserting that is the point
        expect(buildStudioUrl({ address: { address: "::1", family: "IPv6", port: 5173 } })).toBe("http://[::1]:5173/__lunora");
    });

    it("honours a non-root base", () => {
        expect.assertions(1);

        expect(buildStudioUrl({ address: { address: "127.0.0.1", family: "IPv4", port: 5173 }, base: "/app/" })).toBe("http://127.0.0.1:5173/app/__lunora");
    });

    it("falls back to a default when the address is a pipe string or undefined", () => {
        expect.assertions(2);

        // eslint-disable-next-line sonarjs/publicly-writable-directories -- not a real path, just a stand-in for a named-pipe address string
        const pipe = "/tmp/vite.sock";

        expect(buildStudioUrl({ address: pipe })).toBe("http://localhost:5173/__lunora");
        expect(buildStudioUrl({ address: undefined })).toBe("http://localhost:5173/__lunora");
    });
});

/** Admin token written into the project root the plugin is configured with. */
const PROJECT_ROOT_TOKEN = "tok-from-project-root";

describe("studioPlugin", () => {
    it("is a dev-only plugin with a configureServer hook", () => {
        // 2 runtime assertions; the expectTypeOf below is a compile-time check and isn't counted.
        expect.assertions(2);

        const plugin = studioPlugin(makeOptions());

        expect(plugin.name).toBe("lunora:studio");
        expect(plugin.apply).toBe("serve");

        expectTypeOf(plugin.configureServer).not.toBeUndefined();
    });

    it("serves static studio HTML at /__lunora and passes other paths through", () => {
        expect.assertions(7);

        const plugin = studioPlugin(makeOptions());
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

        // A non-studio path calls next() and writes nothing.
        const next = vi.fn<() => void>();
        const passthroughResponse = {
            end: vi.fn<(chunk?: string) => void>(),
            setHeader: vi.fn<(name: string, value: string) => void>(),
            statusCode: 0,
        } as unknown as ServerResponse;

        middleware?.({ url: "/src/main.tsx" }, passthroughResponse, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect((passthroughResponse as unknown as { end: ReturnType<typeof vi.fn> }).end).not.toHaveBeenCalled();

        // The studio path serves the static HTML verbatim — no transform, and
        // it points at the prebuilt static bundle, not a source module.
        const end = vi.fn<(chunk?: string) => void>();
        const dashResponse = { end, setHeader: vi.fn<(name: string, value: string) => void>(), statusCode: 0 } as unknown as ServerResponse;
        const dashNext = vi.fn<() => void>();

        middleware?.({ url: STUDIO_PATH }, dashResponse, dashNext);

        expect(dashNext).not.toHaveBeenCalled();
        expect(end).toHaveBeenCalledTimes(1);
        expect((end.mock.calls[0] as [string])[0]).toContain(`${STUDIO_PATH}/studio.js`);

        // The post-hook announces the studio URL.
        post();

        // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock on the fake server's logger; no `this` binding to lose
        expect(server.config.logger.info).toHaveBeenCalledWith(expect.stringContaining("/__lunora"));
    });

    const installMiddleware = (
        configuredHost: unknown,
        base = "/",
        options: ResolvedLunoraPluginOptions = makeOptions(),
    ): ((request: { url?: string }, response: ServerResponse, next: () => void) => void) => {
        const plugin = studioPlugin(options);
        let middleware: ((request: { url?: string }, response: ServerResponse, next: () => void) => void) | undefined;

        const server = {
            config: {
                base,
                logger: { info: vi.fn<(message: string) => void>(), warnOnce: vi.fn<(message: string) => void>() },
                server: { host: configuredHost },
            },
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

    it("serves the studio at the base-prefixed URL it announces", () => {
        expect.assertions(3);

        // This middleware runs BEFORE Vite's base middleware strips the prefix,
        // so under `base: "/app/"` the announced `…/app/__lunora` used to fall
        // through to the SPA fallback and serve the app's index.html instead.
        const middleware = installMiddleware("localhost", "/app/");
        const prefixed = makeResponse();

        middleware({ url: "/app/__lunora" }, prefixed.response, vi.fn<() => void>());

        expect((prefixed.end.mock.calls[0] as [string])[0]).toContain(`${STUDIO_PATH}/studio.js`);

        // The document's own asset URLs are un-prefixed, so both spellings answer.
        const bare = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: STUDIO_PATH }, bare.response, next);

        expect(next).not.toHaveBeenCalled();
        expect(bare.end).toHaveBeenCalledTimes(1);
    });

    it("reads the schema and admin token from the plugin's projectRoot, not Vite's root", async () => {
        expect.assertions(2);

        // `lunora({ schemaDir })` has to be honest for the studio too: the schema
        // editor answered 404 and the seed/policy endpoints wrote into `lunora/`
        // whatever the option said, because the middleware forwarded neither.
        const root = mkdtempSync(join(tmpdir(), "lunora-studio-root-"));

        mkdirSync(join(root, "backend"), { recursive: true });
        writeFileSync(join(root, "backend", "schema.ts"), "export default {};\n", "utf8");
        writeFileSync(join(root, ".dev.vars"), `LUNORA_ADMIN_TOKEN=${JSON.stringify(PROJECT_ROOT_TOKEN)}\n`, "utf8");

        const middleware = installMiddleware("localhost", "/", makeOptions({ projectRoot: root, schemaDir: "backend" }));
        const { end, response } = makeResponse();

        middleware({ url: STUDIO_PATH }, response, vi.fn<() => void>());

        expect((end.mock.calls[0] as [string])[0]).toContain(PROJECT_ROOT_TOKEN);

        const edit = makeResponse();

        middleware(
            {
                headers: { host: "localhost:5173", "sec-fetch-site": "same-origin" },
                method: "GET",
                socket: { remoteAddress: "127.0.0.1" },
                url: `${STUDIO_PATH}/schema-edit`,
            } as unknown as { url?: string },
            edit.response,
            vi.fn<() => void>(),
        );

        // The handler answers asynchronously (it reads the request body first).
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
        });

        expect((edit.end.mock.calls[0] as [string])[0]).not.toContain("no-schema-file");
    });

    it("serves the token-bearing document with no-store and no ETag", () => {
        expect.assertions(3);

        const middleware = installMiddleware("localhost");
        const { end, response } = makeResponse();

        middleware({ url: STUDIO_PATH }, response, vi.fn<() => void>());

        const headers = Object.fromEntries((response.setHeader as ReturnType<typeof vi.fn>).mock.calls as [string, string][]);

        // The document embeds the admin token, so it must not be cacheable at
        // all — `no-store`, and never an ETag (a cached 304 for a token-bearing
        // document would be its own bug).
        expect(headers["Cache-Control"]).toBe("no-store");
        expect(headers.ETag).toBeUndefined();
        expect(end).toHaveBeenCalledTimes(1);
    });

    it("handles the static asset routes rather than passing them through", () => {
        expect.assertions(5);

        const middleware = installMiddleware("localhost");
        const next = vi.fn<() => void>();

        // Both the script and stylesheet routes are owned by the plugin. They
        // resolve to 200 when @lunora/studio is built, or 501 when it isn't —
        // either way the request must not fall through to the next middleware.
        for (const url of [`${STUDIO_PATH}/studio.js`, `${STUDIO_PATH}/styles.css`]) {
            const { end, response } = makeResponse();

            middleware({ url }, response, next);

            expect([200, 501]).toContain(response.statusCode);
            expect(end).toHaveBeenCalledTimes(1);
        }

        expect(next).not.toHaveBeenCalled();
    });

    it("serves studio assets with revalidation headers and honours a matching ETag", () => {
        // At least one assertion always runs (the 200/501 check below), so this is
        // safe on both the built and unbuilt-studio paths — and it satisfies
        // `vitest/prefer-expect-assertions` (which wants it as the first expression).
        expect.hasAssertions();

        const middleware = installMiddleware("localhost");
        const next = vi.fn<() => void>();
        const { response } = makeResponse();

        middleware({ url: `${STUDIO_PATH}/studio.js` }, response, next);

        // The route is owned by the plugin either way: 200 when @lunora/studio is
        // built, 501 when it isn't (e.g. the affected-test CI env, where the studio
        // dist isn't produced). This unconditional assertion documents both valid
        // states AND keeps the test from reporting "no assertions" on the 501 path,
        // where the ETag branch below legitimately can't run.
        expect([200, 501]).toContain(response.statusCode);

        // No built studio (501) → no asset bytes to cache; the ETag branch can't run.
        // eslint-disable-next-line vitest/no-conditional-in-test -- environment guard: skip when @lunora/studio isn't built (501)
        if (response.statusCode !== 200) {
            return;
        }

        const headers = Object.fromEntries((response.setHeader as ReturnType<typeof vi.fn>).mock.calls as [string, string][]);

        // Unhashed URL → revalidate every load so a rebuild is never shadowed.
        // The ETag is keyed on the requested file (not just its kind) so each
        // chunk revalidates independently — so `studio.js` yields `W/"studio.js-…"`.
        expect(headers["Cache-Control"]).toBe("no-cache");
        expect(headers.ETag).toMatch(/^W\/"studio\.js-/);

        const second = makeResponse();

        middleware({ headers: { "if-none-match": headers.ETag }, url: `${STUDIO_PATH}/studio.js` } as { url?: string }, second.response, next);

        expect(second.response.statusCode).toBe(304);
        expect(second.end).toHaveBeenCalledWith();
        expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 on a non-loopback bind", () => {
        expect.assertions(3);

        const middleware = installMiddleware("0.0.0.0");
        const { end, response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: STUDIO_PATH }, response, next);

        expect(response.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect((end.mock.calls[0] as [string])[0]).toContain("loopback");
    });

    it("403s the schema-edit endpoint on a non-loopback bind", () => {
        expect.assertions(2);

        // The schema-edit endpoint (plan 024) lives under `/__lunora`, so it is
        // gated by the same loopback check as the rest of the studio mount.
        const middleware = installMiddleware("0.0.0.0");
        const { response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: `${STUDIO_PATH}/schema-edit` }, response, next);

        expect(response.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it.each(["localhost", "127.0.0.1", "::1", undefined, false])("serves the studio when host is %s", async (host) => {
        expect.assertions(2);

        const middleware = installMiddleware(host);
        const { response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware({ url: STUDIO_PATH }, response, next);
        await Promise.resolve();
        await Promise.resolve();

        expect(response.statusCode).toBe(200);
        expect(next).not.toHaveBeenCalled();
    });

    it.each([`${STUDIO_PATH}?foo=1`, `${STUDIO_PATH}/`, `${STUDIO_PATH}/?foo=1`])("matches the studio route variant %s", async (url) => {
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

    // A request shape rich enough for the loopback/CSRF gates: headers + a
    // socket peer. The middleware only reads `url`, `method`, `headers`, and
    // `socket.remoteAddress`, so this is enough to drive the security checks.
    type GatedRequest = {
        headers?: Record<string, string>;
        method?: string;
        socket?: { remoteAddress?: string };
        url?: string;
    };

    const callGated = (
        configuredHost: unknown,
        request: GatedRequest,
    ): { end: ReturnType<typeof vi.fn>; next: ReturnType<typeof vi.fn>; response: ServerResponse } => {
        const middleware = installMiddleware(configuredHost);
        const { end, response } = makeResponse();
        const next = vi.fn<() => void>();

        middleware(request, response, next);

        return { end, next, response };
    };

    it("rejects a state-changing endpoint from a non-loopback transport peer", () => {
        expect.assertions(2);

        // Config host is loopback-clean (middleware mode), but the actual peer is
        // public — the per-request transport gate must still 403.
        const { next, response } = callGated(undefined, {
            headers: { host: "localhost:5173" },
            method: "POST",
            socket: { remoteAddress: "203.0.113.7" },
            url: `${STUDIO_PATH}/schema-edit`,
        });

        expect(response.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects a non-localhost Host header (DNS rebinding) on a loopback peer", () => {
        expect.assertions(1);

        const { response } = callGated(undefined, {
            headers: { host: "evil.example.com" },
            method: "GET",
            socket: { remoteAddress: "127.0.0.1" },
            url: STUDIO_PATH,
        });

        expect(response.statusCode).toBe(403);
    });

    it("rejects a proxied request carrying a forwarding header on a loopback peer", () => {
        expect.assertions(1);

        // A local reverse proxy/tunnel connects from 127.0.0.1 and may rewrite
        // Host to localhost, but it adds a forwarding header — its presence means
        // a (possibly remote) client is being relayed, so the admin-token document
        // must be refused rather than trusting the loopback peer + Host.
        const { response } = callGated(undefined, {
            headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" },
            method: "GET",
            socket: { remoteAddress: "127.0.0.1" },
            url: STUDIO_PATH,
        });

        expect(response.statusCode).toBe(403);
    });

    it("logs a warnOnce naming the forwarding header it saw (Codespaces/devcontainers/etc. surface a reason, not just an opaque 403)", () => {
        expect.assertions(1);

        const plugin = studioPlugin(makeOptions());
        let middleware: ((request: unknown, response: ServerResponse, next: () => void) => void) | undefined;
        const warnOnce = vi.fn<(message: string) => void>();

        const server = {
            config: {
                base: "/",
                logger: { info: vi.fn<(message: string) => void>(), warnOnce },
                server: { host: undefined },
            },
            httpServer: { listening: false, once: vi.fn<() => void>() },
            middlewares: {
                use: (function_: typeof middleware) => {
                    middleware = function_;
                },
            },
            transformIndexHtml: vi.fn<(url: string, html: string) => Promise<string>>(async (_url: string, html: string) => html),
        } as unknown as ViteDevServer;

        (plugin.configureServer as (s: ViteDevServer) => unknown)(server);

        const { response } = makeResponse();

        middleware?.(
            { headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" }, url: STUDIO_PATH },
            response,
            vi.fn(),
        );

        expect(warnOnce).toHaveBeenCalledWith(expect.stringContaining(`"x-forwarded-for"`));
    });

    it("rejects a cross-origin POST to schema-edit (CSRF)", () => {
        expect.assertions(1);

        const { response } = callGated("localhost", {
            headers: {
                "content-type": "application/json",
                host: "localhost:5173",
                origin: "http://evil.example.com",
            },
            method: "POST",
            socket: { remoteAddress: "127.0.0.1" },
            url: `${STUDIO_PATH}/schema-edit`,
        });

        expect(response.statusCode).toBe(403);
    });

    it("rejects a simple-request (text/plain) POST to schema-edit (CSRF)", () => {
        expect.assertions(1);

        // A CORS "simple request" carries text/plain and no preflight — must be
        // refused on Content-Type even when same-origin headers are absent.
        const { response } = callGated("localhost", {
            headers: { "content-type": "text/plain;charset=UTF-8", host: "localhost:5173" },
            method: "POST",
            socket: { remoteAddress: "127.0.0.1" },
            url: `${STUDIO_PATH}/seed`,
        });

        expect(response.statusCode).toBe(403);
    });

    it("rejects a non-same-site Sec-Fetch-Site request (CSRF)", () => {
        expect.assertions(1);

        const { response } = callGated("localhost", {
            headers: {
                "content-type": "application/json",
                host: "localhost:5173",
                "sec-fetch-site": "cross-site",
            },
            method: "POST",
            socket: { remoteAddress: "127.0.0.1" },
            url: `${STUDIO_PATH}/policy-scaffold`,
        });

        expect(response.statusCode).toBe(403);
    });

    it.each([`${STUDIO_PATH}/globals`, `${STUDIO_PATH}/data`, `${STUDIO_PATH}/logs/123`])(
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
            // It's the studio document, not an asset.
            expect((end.mock.calls[0] as [string])[0]).toContain(`${STUDIO_PATH}/studio.js`);
        },
    );
});
