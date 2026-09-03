/* eslint-disable sonarjs/no-clear-text-protocols -- SSRF regression fixtures deliberately target http:// private/link-local hosts (metadata endpoint, RFC1918, loopback). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../src/create-browser";
import type { BrowserBindingLike, BrowserLaunchLike, PageLike, RouteLike } from "../src/types";
import { stubDohFetch } from "./_helpers/stub-doh";

// `resolveDns` defaults ON, so every navigation here would otherwise issue a REAL
// Cloudflare DoH request. Answer with a public IP so the re-check is a no-op and
// the guards under test are the only thing deciding. File-wide on purpose — every
// describe below navigates.
/* eslint-disable vitest/require-top-level-describe -- the stub applies to every describe in this file, so it belongs at file scope */
beforeEach(() => {
    stubDohFetch();
});

afterEach(() => {
    vi.unstubAllGlobals();
});
/* eslint-enable vitest/require-top-level-describe */

// `fetch` is required on the marker type (it excludes a bare `{}`) and is typed
// as the real `Fetcher.fetch` so the projections stay assignable from
// `@cloudflare/playwright` (see __tests__/playwright-projection.test-d.ts). The
// fake `launch` chain never calls it, so the body only has to satisfy the shape.
const binding: BrowserBindingLike = { fetch: async () => new Response() };

/**
 * A fake `@cloudflare/playwright` `launch` chain (browser → context → page) that
 * records whether `page.route` was registered and captures the interceptor
 * handler, so a test can drive individual (redirect / sub-resource) requests
 * through it without a real headless browser.
 */
interface Harness {
    gotoCalls: string[];
    launch: BrowserLaunchLike;
    routeHandler?: (route: RouteLike) => unknown;
    routeRegistered: boolean;
}

const makeHarness = (pageContent = "<html></html>"): Harness => {
    const harness: Harness = {
        gotoCalls: [],
        launch: undefined as never,
        routeRegistered: false,
    };

    const page: PageLike = {
        content: async () => pageContent,
        evaluate: async (function_) => function_(),
        goto: async (url) => {
            harness.gotoCalls.push(url);

            return undefined;
        },
        pdf: async () => new Uint8Array(),
        route: async (_pattern, handler) => {
            harness.routeRegistered = true;
            harness.routeHandler = handler;
        },
        screenshot: async () => new Uint8Array(),
    };

    const context = { newPage: async () => page };
    const browser = { close: async () => {}, newContext: async () => context };

    harness.launch = async () => browser;

    return harness;
};

/** A fake `Route` (with spied `abort`/`continue`) for a single intercepted request. */
const makeRoute = (url: string, isNavigation: boolean) => {
    const abort = vi.fn<(errorCode?: string) => Promise<void>>(async () => {});
    const continueFn = vi.fn<() => Promise<void>>(async () => {});

    const route: RouteLike = {
        abort,
        continue: continueFn,
        request: () => {
            return { isNavigationRequest: () => isNavigation, url: () => url };
        },
    };

    return { abort, continueFn, route };
};

describe("createBrowser SSRF redirect guard (finding #6)", () => {
    it("registers the redirect interceptor when allowPrivateTargets is true AND allowedHosts is set", async () => {
        expect.assertions(1);

        const harness = makeHarness();
        const browser = createBrowser({
            allowedHosts: ["example.com"],
            allowPrivateTargets: true,
            binding,
            launch: harness.launch,
        });

        await browser.content("https://example.com/");

        expect(harness.routeRegistered).toBe(true);
    });

    it("does NOT register the interceptor when allowPrivateTargets is true and allowedHosts is unset (no regression)", async () => {
        expect.assertions(1);

        const harness = makeHarness();
        const browser = createBrowser({
            allowPrivateTargets: true,
            binding,
            launch: harness.launch,
        });

        await browser.content("https://example.com/");

        expect(harness.routeRegistered).toBe(false);
    });

    it("aborts a redirect hop to an off-allowlist host under allowPrivateTargets + allowedHosts", async () => {
        expect.assertions(3);

        const harness = makeHarness();
        const browser = createBrowser({
            allowedHosts: ["example.com"],
            allowPrivateTargets: true,
            binding,
            launch: harness.launch,
        });

        await browser.content("https://example.com/");

        expect(harness.routeHandler).toBeDefined();

        const evil = makeRoute("https://evil.example/steal", true);

        await harness.routeHandler?.(evil.route);

        expect(evil.abort).toHaveBeenCalledWith("blockedbyclient");
        expect(evil.continueFn).not.toHaveBeenCalled();
    });

    it("continues a redirect hop that stays on the allowlist", async () => {
        expect.assertions(2);

        const harness = makeHarness();
        const browser = createBrowser({
            allowedHosts: ["example.com"],
            allowPrivateTargets: true,
            binding,
            launch: harness.launch,
        });

        await browser.content("https://example.com/");

        const allowed = makeRoute("https://example.com/next", true);

        await harness.routeHandler?.(allowed.route);

        expect(allowed.continueFn).toHaveBeenCalledTimes(1);
        expect(allowed.abort).not.toHaveBeenCalled();
    });

    it("does not run a per-hop DoH lookup when allowPrivateTargets is true (resolveDns gating companion edit)", async () => {
        expect.assertions(2);

        const fetchSpy = vi.spyOn(globalThis, "fetch");

        try {
            const harness = makeHarness();
            const browser = createBrowser({
                allowedHosts: ["example.com"],
                allowPrivateTargets: true,
                binding,
                launch: harness.launch,
                resolveDns: true,
            });

            await browser.content("https://example.com/");

            const hop = makeRoute("https://example.com/next", true);

            await harness.routeHandler?.(hop.route);

            // The per-hop `resolveDns` branch is gated by `!allowPrivateTargets`,
            // so no DoH `fetch` fires for the intended internal host — the Tunnel
            // config isn't self-rejected.
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(hop.continueFn).toHaveBeenCalledTimes(1);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

describe("createBrowser SSRF sub-resource guard (finding #7)", () => {
    const defaultBrowser = (harness: Harness) => createBrowser({ binding, launch: harness.launch });

    it("aborts a sub-resource request to a private/link-local host", async () => {
        expect.assertions(3);

        const harness = makeHarness();

        await defaultBrowser(harness).content("https://example.com/");

        expect(harness.routeHandler).toBeDefined();

        const metadata = makeRoute("http://169.254.169.254/latest/meta-data/", false);

        await harness.routeHandler?.(metadata.route);

        expect(metadata.abort).toHaveBeenCalledWith("blockedbyclient");
        expect(metadata.continueFn).not.toHaveBeenCalled();
    });

    it("aborts a sub-resource request to a loopback / localhost host", async () => {
        expect.assertions(2);

        const harness = makeHarness();

        await defaultBrowser(harness).content("https://example.com/");

        const loopback = makeRoute("http://localhost:6379/", false);
        const rfc1918 = makeRoute("http://10.0.0.5/probe", false);

        await harness.routeHandler?.(loopback.route);
        await harness.routeHandler?.(rfc1918.route);

        expect(loopback.abort).toHaveBeenCalledWith("blockedbyclient");
        expect(rfc1918.abort).toHaveBeenCalledWith("blockedbyclient");
    });

    it("continues a sub-resource request to a public host", async () => {
        expect.assertions(2);

        const harness = makeHarness();

        await defaultBrowser(harness).content("https://example.com/");

        const cdn = makeRoute("https://cdn.example.net/app.js", false);

        await harness.routeHandler?.(cdn.route);

        expect(cdn.continueFn).toHaveBeenCalledTimes(1);
        expect(cdn.abort).not.toHaveBeenCalled();
    });

    it("continues non-http(s) sub-resources (data:/blob:) so inline assets keep rendering", async () => {
        expect.assertions(4);

        const harness = makeHarness();

        await defaultBrowser(harness).content("https://example.com/");

        const dataUri = makeRoute("data:image/png;base64,iVBORw0KGgo=", false);
        const blob = makeRoute("blob:https://example.com/9f8c-uuid", false);

        await harness.routeHandler?.(dataUri.route);
        await harness.routeHandler?.(blob.route);

        expect(dataUri.continueFn).toHaveBeenCalledTimes(1);
        expect(dataUri.abort).not.toHaveBeenCalled();
        expect(blob.continueFn).toHaveBeenCalledTimes(1);
        expect(blob.abort).not.toHaveBeenCalled();
    });

    it("aborts a public but off-allowlist sub-resource when allowedHosts is configured", async () => {
        expect.assertions(3);

        const harness = makeHarness();
        const browser = createBrowser({ allowedHosts: ["example.com"], binding, launch: harness.launch });

        await browser.content("https://example.com/");

        const offList = makeRoute("https://cdn.other.net/app.js", false);
        const onList = makeRoute("https://example.com/app.js", false);

        await harness.routeHandler?.(offList.route);
        await harness.routeHandler?.(onList.route);

        expect(offList.abort).toHaveBeenCalledWith("blockedbyclient");
        expect(onList.continueFn).toHaveBeenCalledTimes(1);
        expect(onList.abort).not.toHaveBeenCalled();
    });
});

describe("createBrowser operation timeout (finding #1)", () => {
    it("rejects when a post-navigation operation exceeds the timeout budget", async () => {
        expect.assertions(1);

        // A hostile page that traps the evaluated function: `page.evaluate` never
        // resolves. `page.goto` returns fine, so only the outer deadline bounds it.
        const page: PageLike = {
            content: async () => "<html></html>",
            evaluate: () => new Promise<never>(() => {}),
            goto: async () => undefined,
            pdf: async () => new Uint8Array(),
            screenshot: async () => new Uint8Array(),
        };
        const context = { newPage: async () => page };
        const browser = { close: async () => {}, newContext: async () => context };
        const launch: BrowserLaunchLike = async () => browser;

        const client = createBrowser({ binding, launch });

        await expect(client.scrape("https://example.com/", () => 1, { timeoutMs: 10 })).rejects.toThrow(/exceeded the 10ms timeout budget/);
    });

    it("closes the browser when the deadline rejects (no leaked session)", async () => {
        expect.assertions(2);

        let closed = false;
        const page: PageLike = {
            content: () => new Promise<never>(() => {}),
            evaluate: async (function_) => function_(),
            goto: async () => undefined,
            pdf: async () => new Uint8Array(),
            screenshot: async () => new Uint8Array(),
        };
        const context = { newPage: async () => page };
        const browser = {
            close: async () => {
                closed = true;
            },
            newContext: async () => context,
        };
        const launch: BrowserLaunchLike = async () => browser;

        const client = createBrowser({ binding, launch });

        await expect(client.content("https://example.com/", { timeoutMs: 10 })).rejects.toThrow(/timeout budget/);
        expect(closed).toBe(true);
    });
});

describe("createBrowser URL-boundary error codes (finding #2)", () => {
    it("rejects a private/internal target as a FORBIDDEN 403 (message intact, not a redacted 500)", async () => {
        expect.assertions(2);

        const harness = makeHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.content("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(harness.gotoCalls).toHaveLength(0);
    });

    it("rejects a non-http(s) scheme as a BAD_REQUEST 400", async () => {
        expect.assertions(1);

        const harness = makeHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.content("ftp://example.com/file")).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    });

    it("rejects embedded credentials as a BAD_REQUEST 400", async () => {
        expect.assertions(1);

        const harness = makeHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.content("https://user:pass@example.com/")).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 }); // gitleaks:allow -- test fixture asserting embedded-credential rejection, not a real secret
    });
});

describe("session reuse", () => {
    /**
     * A browser whose `close()` is observable, so a test can assert the session
     * is (or is not) torn down — that distinction IS the feature.
     */
    const makeSessionHarness = () => {
        const closed = vi.fn<() => Promise<void>>(async () => {});
        const browser = {
            close: closed,
            newContext: async () => {
                return { newPage: async () => ({}) as PageLike };
            },
        };
        const launchOptions: (Record<string, unknown> | undefined)[] = [];

        return {
            browser,
            closed,
            connect: vi.fn<(binding: BrowserBindingLike, sessionId: string) => Promise<typeof browser>>(async () => browser),
            launch: (async (_binding, options) => {
                launchOptions.push(options);

                return browser;
            }) as BrowserLaunchLike,
            launchOptions,
        };
    };

    it("keeps the session open when launch is given keepAlive", async () => {
        expect.assertions(3);

        // Without this the per-call lifecycle closes the browser, and a model
        // driving navigate → click → extract as three separate action
        // invocations gets a blank page on step two — silently.
        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.launch(async () => "done", { keepAlive: 600 })).resolves.toBe("done");

        // Seconds on our API, milliseconds on Cloudflare's `keep_alive`.
        expect(harness.launchOptions[0]).toStrictEqual({ keep_alive: 600_000 });
        expect(harness.closed).not.toHaveBeenCalled();
    });

    it("still always closes when keepAlive is omitted", async () => {
        expect.assertions(2);

        // A leaked Browser Rendering session is billed and rate-limited, so the
        // default must stay always-close.
        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await browser.launch(async () => "done");

        expect(harness.launchOptions[0]).toBeUndefined();
        expect(harness.closed).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["zero", 0],
        ["negative", -5],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
    ])("still always closes when keepAlive is %s", async (_label, keepAlive) => {
        expect.assertions(2);

        // `keepAlive: 0` is the natural spelling of "do not keep alive", and what
        // a `Number(...)` over an unset env var yields, so it must take the
        // always-close path rather than skipping the `finally`
        // AND sending `keep_alive: 0`/`NaN` — that leaks a billed session. The
        // sibling numeric inputs (`timeoutMs`, `viewport`) already reject
        // non-finite values; this one did not.
        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await browser.launch(async () => "done", { keepAlive });

        expect(harness.launchOptions[0]).toBeUndefined();
        expect(harness.closed).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["below the 10s floor", 1],
        ["just below the floor", 9],
        ["above the 10min ceiling", 601],
    ])("rejects a keepAlive %s instead of sending it", async (_label, keepAlive) => {
        expect.assertions(3);

        // Browser Rendering documents `keep_alive` as 10_000ms–600_000ms, so
        // `keepAlive: 1` sends 1_000 and the launch fails at Cloudflare with an
        // error that names none of this. Refuse at the boundary — and never
        // reach `launch`, since a partially-launched session is the billed leak
        // the whole surface is built around.
        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.launch(async () => "done", { keepAlive })).rejects.toThrow(/keepAlive must be between 10 and 600 seconds/u);

        expect(harness.launchOptions).toHaveLength(0);
        expect(harness.closed).not.toHaveBeenCalled();
    });

    it.each([
        ["the floor", 10],
        ["the ceiling", 600],
    ])("accepts a keepAlive at %s", async (_label, keepAlive) => {
        expect.assertions(2);

        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(browser.launch(async () => "done", { keepAlive })).resolves.toBe("done");

        expect(harness.launchOptions[0]).toStrictEqual({ keep_alive: keepAlive * 1000 });
    });

    it("connect re-attaches without closing, unless asked", async () => {
        expect.assertions(4);

        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, connect: harness.connect, launch: harness.launch });

        await expect(browser.connect("sess-1", async () => "attached")).resolves.toBe("attached");
        expect(harness.connect).toHaveBeenCalledWith(binding, "sess-1");
        // Not closed — keeping the page alive across invocations is the point.
        expect(harness.closed).not.toHaveBeenCalled();

        await browser.connect("sess-1", async () => "done", { close: true });

        expect(harness.closed).toHaveBeenCalledTimes(1);
    });

    it("hands the session id to the caller so connect() is reachable", async () => {
        expect.assertions(2);

        // Without this the documented flow is a dead end: `keepAlive` holds a
        // session open but nothing tells you which one, and `sessions()` lists
        // them all with no way to identify yours.
        const harness = makeSessionHarness();
        const withId = { ...harness.browser, sessionId: () => "sess-42" };
        const browser = createBrowser({ binding, launch: async () => withId });

        const captured = await browser.launch(async (b) => b.sessionId?.(), { keepAlive: 600 });

        expect(captured).toBe("sess-42");
        expect(harness.closed).not.toHaveBeenCalled();
    });

    it("throws when the handler throws with keepAlive set, leaving the session open", async () => {
        expect.assertions(2);

        // The `finally` close is deliberately skipped under keepAlive; make sure
        // the error still propagates rather than being swallowed with it.
        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, launch: harness.launch });

        await expect(
            browser.launch(
                async () => {
                    throw new Error("boom");
                },
                { keepAlive: 60 },
            ),
        ).rejects.toThrow("boom");

        expect(harness.closed).not.toHaveBeenCalled();
    });

    it("lists live sessions", async () => {
        expect.assertions(1);

        const live = [{ sessionId: "sess-1" }, { connectionId: "conn-9", sessionId: "sess-2" }];
        const browser = createBrowser({ binding, launch: makeSessionHarness().launch, sessions: async () => live });

        // `sess-2` carries a connectionId — already held by another worker, so a
        // caller picking a session to connect to must skip it.
        await expect(browser.sessions()).resolves.toStrictEqual(live);
    });

    it("names the missing peer export rather than failing obscurely", async () => {
        expect.assertions(2);

        const browser = createBrowser({ binding, launch: makeSessionHarness().launch });

        await expect(browser.connect("sess-1", async () => "x")).rejects.toThrow(/`connect` is not available/u);
        await expect(browser.sessions()).rejects.toThrow(/`sessions` is not available/u);
    });
});
