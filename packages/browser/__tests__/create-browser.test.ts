/* eslint-disable sonarjs/no-clear-text-protocols -- SSRF regression fixtures deliberately target http:// private/link-local hosts (metadata endpoint, RFC1918, loopback). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../src/create-browser";
import type { BrowserBindingLike, BrowserContextLike, BrowserLaunchLike, BrowserLike } from "../src/types";
import { fakeBinding, fakeLaunch } from "./_helpers/fake-launch";
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

const binding: BrowserBindingLike = fakeBinding();

describe("createBrowser SSRF navigation guard (finding #6)", () => {
    it("installs the guard when allowPrivateTargets is true AND allowedHosts is set", async () => {
        expect.assertions(1);

        const launch = fakeLaunch();
        const browser = createBrowser({ allowedHosts: ["example.com"], allowPrivateTargets: true, binding, launch });

        await browser.content("https://example.com/");

        expect(launch.routeHandlers).toHaveLength(1);
    });

    it("does NOT install it when allowPrivateTargets is true and allowedHosts is unset (no regression)", async () => {
        expect.assertions(1);

        const launch = fakeLaunch();
        const browser = createBrowser({ allowPrivateTargets: true, binding, launch });

        await browser.content("https://example.com/");

        expect(launch.routeHandlers).toHaveLength(0);
    });

    it("aborts a navigation to an off-allowlist host under allowPrivateTargets + allowedHosts, without requesting it", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();
        const browser = createBrowser({ allowedHosts: ["example.com"], allowPrivateTargets: true, binding, launch });

        await browser.content("https://example.com/");

        const outcome = await launch.dispatch("https://evil.example/steal", { navigation: true });

        expect(outcome.aborted).toBe("blockedbyclient");
        expect(outcome.fetched).toHaveLength(0);
    });

    it("fetches an allowed navigation itself, one hop, and hands the response to the browser", async () => {
        expect.assertions(3);

        const launch = fakeLaunch();
        const browser = createBrowser({ allowedHosts: ["example.com"], allowPrivateTargets: true, binding, launch });

        await browser.content("https://example.com/");

        const outcome = await launch.dispatch("https://example.com/next", { navigation: true });

        expect(outcome.fetched).toStrictEqual(["https://example.com/next"]);
        expect(outcome.fulfilled?.response).toBeDefined();
        expect(outcome.continued).toBe(false);
    });

    it("answers an iframe's allowed redirect with a fresh navigation, and aborts a private one", async () => {
        expect.assertions(3);

        const launch = fakeLaunch({
            network: (url) => {
                if (url === "https://example.com/frame-public") {
                    return { headers: { location: "https://cdn.example.net/x" }, status: 302 };
                }

                if (url === "https://example.com/frame-private") {
                    return { headers: { location: "http://169.254.169.254/latest/meta-data/" }, status: 302 };
                }

                return { status: 200 };
            },
        });

        await createBrowser({ binding, launch }).content("https://example.com/");

        const iframe = { frame: "child" };
        const allowed = await launch.dispatch("https://example.com/frame-public", { ...iframe, navigation: true });
        const refused = await launch.dispatch("https://example.com/frame-private", { ...iframe, navigation: true });

        expect(allowed.fulfilled?.body).toContain('content="0;url=https://cdn.example.net/x"');
        expect(refused.aborted).toBe("blockedbyclient");
        expect(launch.requested).not.toContain("http://169.254.169.254/latest/meta-data/");
    });

    it("does not run a per-hop DoH lookup when allowPrivateTargets is true (resolveDns gating companion edit)", async () => {
        expect.assertions(2);

        const fetchSpy = vi.spyOn(globalThis, "fetch");

        try {
            const launch = fakeLaunch();
            const browser = createBrowser({ allowedHosts: ["example.com"], allowPrivateTargets: true, binding, launch, resolveDns: true });

            await browser.content("https://example.com/");

            const outcome = await launch.dispatch("https://example.com/next", { navigation: true });

            // The per-hop `resolveDns` branch is gated by `!allowPrivateTargets`,
            // so no DoH `fetch` fires for the intended internal host — the Tunnel
            // config isn't self-rejected.
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(outcome.fulfilled).toBeDefined();
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

describe("createBrowser SSRF sub-resource guard (finding #7)", () => {
    const subresource = { navigation: false };

    it("aborts a sub-resource request to a private/link-local host", async () => {
        expect.assertions(1);

        const launch = fakeLaunch();

        await createBrowser({ binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("http://169.254.169.254/latest/meta-data/", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
    });

    it("aborts a sub-resource request to a loopback / localhost host", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();

        await createBrowser({ binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("http://localhost:6379/", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
        await expect(launch.dispatch("http://10.0.0.5/probe", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
    });

    it("continues a sub-resource request to a public host", async () => {
        expect.assertions(1);

        const launch = fakeLaunch();

        await createBrowser({ binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("https://cdn.example.net/app.js", subresource)).resolves.toMatchObject({ continued: true });
    });

    it("continues non-http(s) sub-resources (data:/blob:) so inline assets keep rendering", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();

        await createBrowser({ binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("data:image/png;base64,iVBORw0KGgo=", subresource)).resolves.toMatchObject({ continued: true });
        await expect(launch.dispatch("blob:https://example.com/9f8c-uuid", subresource)).resolves.toMatchObject({ continued: true });
    });

    it("aborts a public but off-allowlist sub-resource when allowedHosts is configured", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();

        await createBrowser({ allowedHosts: ["example.com"], binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("https://cdn.other.net/app.js", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
        await expect(launch.dispatch("https://example.com/app.js", subresource)).resolves.toMatchObject({ continued: true });
    });

    it("continues an allowlisted private sub-resource under allowPrivateTargets (the Tunnel config)", async () => {
        expect.assertions(3);

        // The documented internal-dashboard config: render an internal host
        // reached over a Tunnel, pinned to an allowlist. The sub-resource guard
        // used to run `isPrivateHost` ungated, aborting every asset from the SAME
        // allowlisted host, so the render came back unstyled with no error.
        const launch = fakeLaunch();

        await createBrowser({ allowedHosts: ["dashboard.internal"], allowPrivateTargets: true, binding, launch }).content("https://dashboard.internal/report");

        for (const asset of ["app.css", "app.js", "logo.png"]) {
            // eslint-disable-next-line no-await-in-loop -- one request at a time, as the page issues them
            await expect(launch.dispatch(`https://dashboard.internal/${asset}`, subresource)).resolves.toMatchObject({ continued: true });
        }
    });

    it("still aborts an off-allowlist private sub-resource under allowPrivateTargets", async () => {
        expect.assertions(1);

        // `allowPrivateTargets` relaxes the private-address arm, never the allowlist.
        const launch = fakeLaunch();

        await createBrowser({ allowedHosts: ["dashboard.internal"], allowPrivateTargets: true, binding, launch }).content("https://dashboard.internal/report");

        await expect(launch.dispatch("http://169.254.169.254/latest/meta-data/", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
    });

    it("fails closed on an unparseable sub-resource URL, as the navigation sibling does", async () => {
        expect.assertions(1);

        const launch = fakeLaunch();

        await createBrowser({ binding, launch }).content("https://example.com/");

        await expect(launch.dispatch("://not a url", subresource)).resolves.toMatchObject({ aborted: "blockedbyclient" });
    });
});

describe("allowedHosts normalization", () => {
    it("matches a Unicode (IDN) entry against the punycode hostname a URL carries", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();
        const browser = createBrowser({ allowedHosts: ["bücher.example"], binding, launch });

        await expect(browser.content("https://bücher.example/")).resolves.toContain("hi");
        expect(launch.launchOptions[0]).toMatchObject({ guardrails: { allowedDomains: ["xn--bcher-kva.example"] } });
    });
});

describe("createBrowser operation timeout (finding #1)", () => {
    it("rejects when a post-navigation operation exceeds the timeout budget", async () => {
        expect.assertions(1);

        // A hostile page that traps the evaluated function: `page.evaluate` never
        // resolves. `page.goto` returns fine, so only the outer deadline bounds it.
        const launch = fakeLaunch({ page: { evaluate: async () => new Promise<never>(() => {}) } });
        const client = createBrowser({ binding, launch });

        await expect(client.scrape("https://example.com/", () => 1, { timeoutMs: 10 })).rejects.toThrow(/exceeded the 10ms timeout budget/);
    });

    it("closes the browser when the deadline rejects (no leaked session)", async () => {
        expect.assertions(2);

        const launch = fakeLaunch({ page: { content: async () => new Promise<never>(() => {}) } });
        const client = createBrowser({ binding, launch });

        await expect(client.content("https://example.com/", { timeoutMs: 10 })).rejects.toThrow(/timeout budget/);
        expect(launch.browsers[0]!.closed).toBe(1);
    });
});

describe("createBrowser URL-boundary error codes (finding #2)", () => {
    it("rejects a private/internal target as a FORBIDDEN 403 (message intact, not a redacted 500)", async () => {
        expect.assertions(2);

        const launch = fakeLaunch();
        const browser = createBrowser({ binding, launch });

        await expect(browser.content("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(launch.browsers).toHaveLength(0);
    });

    it("rejects a non-http(s) scheme as a BAD_REQUEST 400", async () => {
        expect.assertions(1);

        const browser = createBrowser({ binding, launch: fakeLaunch() });

        await expect(browser.content("ftp://example.com/file")).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    });

    it("rejects embedded credentials as a BAD_REQUEST 400", async () => {
        expect.assertions(1);

        const browser = createBrowser({ binding, launch: fakeLaunch() });

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
        const inner = fakeLaunch();
        const route = vi.fn<BrowserContextLike["route"]>(async () => {});
        const browser: BrowserLike = {
            close: closed,
            // A shared session: another caller's context is already open on it.
            contexts: () => [{ newPage: async () => ({}) as never, route }],
            newContext: async () => {
                const fresh = await inner(binding);

                return fresh.newContext();
            },
        };
        const launchOptions: (Record<string, unknown> | undefined)[] = [];

        return {
            browser,
            closed,
            requested: inner.requested,
            route,
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

    it("closes a keepAlive session when the handler throws, and rethrows", async () => {
        expect.assertions(2);

        // A throw means nobody will `connect` to the session, and a held session
        // is billed until `keepAlive` lapses, so it is closed, and the error
        // still propagates.
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

        expect(harness.closed).toHaveBeenCalledTimes(1);
    });

    it("guards a re-attached session: its open contexts and every new one", async () => {
        expect.assertions(3);

        const harness = makeSessionHarness();
        const browser = createBrowser({ binding, connect: harness.connect });

        await browser.connect("sess-1", async (attached) => {
            const context = await attached.newContext();
            const page = await context.newPage();

            await expect(page.goto("http://10.0.0.5/admin")).rejects.toThrow(/BLOCKEDBYCLIENT/u);
        });

        // The context that was already open got the guard too.
        expect(harness.route).toHaveBeenCalledWith("**/*", expect.any(Function));
        expect(harness.requested).toHaveLength(0);
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
