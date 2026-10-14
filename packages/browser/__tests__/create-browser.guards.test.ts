import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../src/create-browser";
import { fakeBinding, fakeLaunch } from "./_helpers/fake-launch";
import { stubDohFetch } from "./_helpers/stub-doh";

describe("createBrowser", () => {
    // `resolveDns` defaults ON, so every navigation would otherwise issue a REAL
    // Cloudflare DoH request from the suite. Answer it with a public IP by default;
    // the rebinding describe below re-stubs `fetch` per test for its own answers.
    beforeEach(() => {
        stubDohFetch();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("throws when no binding is supplied", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the JS-caller misuse path
        expect(() => createBrowser({})).toThrow(/`binding` is required/);
    });

    it("throws on first use when launch is not available", async () => {
        expect.assertions(1);

        const browser = createBrowser({ binding: fakeBinding() });

        await expect(browser.screenshot("https://example.com")).rejects.toThrow(/@cloudflare\/playwright/);
    });

    describe("screenshot", () => {
        it("navigates to the validated url and returns the bytes", async () => {
            expect.assertions(3);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            const bytes = await browser.screenshot("https://example.com/page");

            expect(launch.browsers).toHaveLength(1);
            expect(launch.browsers[0]!.pages[0]!.gotoCalls).toStrictEqual(["https://example.com/page"]);
            expect(bytes).toStrictEqual(new Uint8Array([137, 80, 78, 71]));
        });

        it("defaults to a png and forwards type/fullPage", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.screenshot("https://example.com", { fullPage: true, type: "jpeg" });

            expect(launch.browsers[0]!.pages[0]!.screenshotCalls[0]).toStrictEqual({ fullPage: true, type: "jpeg" });
        });

        it("clamps an oversized viewport via setViewportSize", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.screenshot("https://example.com", { viewport: { height: 999_999, width: 999_999 } });

            expect(launch.browsers[0]!.pages[0]!.viewportCalls).toStrictEqual([{ height: 4320, width: 3840 }]);
        });

        it("closes the browser even when goto throws", async () => {
            expect.assertions(2);

            const launch = fakeLaunch({ gotoThrows: true });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.screenshot("https://example.com")).rejects.toThrow(/navigation failed/);

            expect(launch.browsers[0]!.closed).toBe(1);
        });
    });

    describe("viewport / timeout clamping", () => {
        it("falls back to the viewport caps when a dimension is non-finite", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.screenshot("https://example.com", { viewport: { height: Number.NaN, width: Number.POSITIVE_INFINITY } });

            expect(launch.browsers[0]!.pages[0]!.viewportCalls).toStrictEqual([{ height: 4320, width: 3840 }]);
        });

        it("floors viewport dimensions below 1 up to 1", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.screenshot("https://example.com", { viewport: { height: 0, width: -50 } });

            expect(launch.browsers[0]!.pages[0]!.viewportCalls).toStrictEqual([{ height: 1, width: 1 }]);
        });

        it("clamps a per-call timeout above the ceiling and forwards it to goto", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("https://example.com", { timeoutMs: 999_999, waitUntil: "domcontentloaded" });

            expect(launch.browsers[0]!.pages[0]!.gotoOptions[0]).toStrictEqual({ timeout: 120_000, waitUntil: "domcontentloaded" });
        });

        it("falls back to the default timeout when the per-call value is non-finite", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("https://example.com", { timeoutMs: Number.NaN });

            expect(launch.browsers[0]!.pages[0]!.gotoOptions[0]).toStrictEqual({ timeout: 30_000, waitUntil: "load" });
        });

        it("uses the factory timeout when no per-call timeout is given", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, timeoutMs: 5000 });

            await browser.content("https://example.com");

            expect(launch.browsers[0]!.pages[0]!.gotoOptions[0]).toStrictEqual({ timeout: 5000, waitUntil: "load" });
        });
    });

    describe("url validation", () => {
        /* eslint-disable sonarjs/no-clear-text-protocols -- intentional test fixtures: these http URLs assert the scheme/SSRF guard rejects them; no real connection is made */
        const cases: [string, string][] = [
            ["empty", ""],
            ["ftp", "ftp://example.com"],
            // eslint-disable-next-line no-script-url -- intentional test fixture: asserts the validator rejects the `javascript:` scheme
            ["javascript", "javascript:alert(1)"],
            ["file", "file:///etc/passwd"],
            ["data", "data:text/html,<h1>x</h1>"],
            ["relative", "/just/a/path"],
            // SSRF: private / internal / loopback / link-local targets are default-denied.
            ["localhost", "http://localhost:3000"],
            ["loopback v4", "http://127.0.0.1/admin"],
            ["loopback integer", "http://2130706433"],
            ["private 10/8", "http://10.0.0.5"],
            ["private 172.16/12", "http://172.16.4.4"],
            ["private 192.168/16", "https://192.168.1.1"],
            ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
            ["cgnat", "http://100.64.0.1"],
            ["ipv6 loopback", "http://[::1]:8080"],
            ["ipv6 ula", "http://[fd00::1]"],
            ["ipv6 mapped loopback", "http://[::ffff:127.0.0.1]"],
            [".internal", "https://api.internal/health"],
            [".local", "http://printer.local"],
            ["embedded credentials", "https://user:pass@example.com"], // gitleaks:allow -- test fixture asserting credential rejection, not a real secret
            // IPv4-compatible / NAT64 SSRF bypass regression (the WHATWG URL parser
            // normalises `::127.0.0.1` to the hex form `::7f00:1`).
            ["ipv6 compatible loopback hex", "http://[::7f00:1]/"],
            ["ipv6 compatible private 10.x hex", "http://[::a00:1]/"],
            ["ipv6 nat64 loopback", "http://[64:ff9b::7f00:1]/"],
            ["ipv6 nat64 link-local metadata", "http://[64:ff9b::a9fe:a9fe]/"],
        ];
        /* eslint-enable sonarjs/no-clear-text-protocols */

        it.each(cases)("rejects a %s url without launching the browser", async (_label, url) => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.screenshot(url)).rejects.toThrow(/@lunora\/browser/);
            expect(launch.browsers).toHaveLength(0);
        });

        it("accepts http and https", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("http://example.com");
            await browser.content("https://example.com");

            expect(launch.browsers).toHaveLength(2);
        });

        it("navigates to a private host when allowPrivateTargets is set", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ allowPrivateTargets: true, binding: fakeBinding(), launch });

            await browser.content("http://127.0.0.1:8787/health");

            expect(launch.browsers).toHaveLength(1);
            expect(launch.browsers[0]?.pages[0]?.gotoCalls).toEqual(["http://127.0.0.1:8787/health"]);
        });

        it("still rejects a non-http scheme even with allowPrivateTargets", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ allowPrivateTargets: true, binding: fakeBinding(), launch });

            await expect(browser.screenshot("file:///etc/passwd")).rejects.toThrow(/@lunora\/browser/);
            expect(launch.browsers).toHaveLength(0);
        });
    });

    describe("allowedHosts strict allowlist", () => {
        it("rejects a public host not on the allowlist without launching", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ allowedHosts: ["example.com"], binding: fakeBinding(), launch });

            await expect(browser.content("https://evil.example.net")).rejects.toThrow(/not in the configured allowedHosts allowlist/);
            expect(launch.browsers).toHaveLength(0);
        });

        it("accepts a host on the allowlist (case-insensitive, trailing-dot-normalized)", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ allowedHosts: ["Example.com"], binding: fakeBinding(), launch });

            await browser.content("https://example.com./page");

            expect(launch.browsers).toHaveLength(1);
        });

        it("an EMPTY allowedHosts allows nothing — it is a configured allowlist, not an absent one", async () => {
            expect.assertions(2);

            // `[]` used to mean "no allowlist": the guard was `allowedHosts.length > 0`,
            // so every host was permitted, while the advisor's
            // `browser_user_url_without_allowlist` suppressed on the key being
            // PRESENT. The config read as hardened and was not.
            const launch = fakeLaunch();
            const browser = createBrowser({ allowedHosts: [], binding: fakeBinding(), launch });

            await expect(browser.content("https://example.com/page")).rejects.toThrow(/allowedHosts is configured but EMPTY/);
            expect(launch.browsers).toHaveLength(0);
        });

        it("an EMPTY allowedHosts refuses even a private target the allowPrivateTargets escape hatch would permit", async () => {
            expect.assertions(2);

            // The allowlist arm is not relaxed by `allowPrivateTargets`, so the
            // combination that skipped BOTH guards before — empty list (allowlist
            // off) plus the flag (private-target guard off, redirect interception
            // never registered) — now refuses outright.
            const launch = fakeLaunch();
            const browser = createBrowser({ allowPrivateTargets: true, allowedHosts: [], binding: fakeBinding(), launch });

            await expect(browser.content("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/allowedHosts is configured but EMPTY/);
            expect(launch.browsers).toHaveLength(0);
        });
    });

    /* eslint-disable sonarjs/no-hardcoded-ip -- intentional test fixtures: these are DoH-resolved IPs asserting the rebinding guard classifies them; no real connection is made */
    describe("resolveDns rebinding re-check", () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it("runs BY DEFAULT — a rebinding host is refused with no resolveDns option set", async () => {
            expect.assertions(2);

            stubDohFetch({ 1: [{ data: "169.254.169.254", type: 1 }] });
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://rebind.example.com")).rejects.toThrow(/resolves to a private\/internal address/);
            expect(launch.browsers).toHaveLength(0);
        });

        it("can be turned off explicitly with resolveDns: false", async () => {
            expect.assertions(2);

            const fetchMock = stubDohFetch({ 1: [{ data: "169.254.169.254", type: 1 }] });
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: false });

            await browser.content("https://rebind.example.com");

            expect(launch.browsers).toHaveLength(1);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("rejects a public host that resolves to a private IP, before launching", async () => {
            expect.assertions(3);

            const fetchMock = stubDohFetch({ 1: [{ data: "169.254.169.254", type: 1 }] });
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await expect(browser.content("https://rebind.example.com")).rejects.toThrow(/resolves to a private\/internal address/);
            expect(launch.browsers).toHaveLength(0);
            expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
        });

        it("allows a public host that resolves to a public IP", async () => {
            expect.assertions(2);

            const fetchMock = stubDohFetch({ 1: [{ data: "93.184.216.34", type: 1 }], 28: [{ data: "2606:2800:220:1:248:1893:25c8:1946", type: 28 }] });
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await browser.content("https://example.com");

            expect(launch.browsers).toHaveLength(1);
            expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
        });

        it("rejects a public host that resolves to a private IPv6 (AAAA)", async () => {
            expect.assertions(1);

            stubDohFetch({ 1: [], 28: [{ data: "fd00::1", type: 28 }] });
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await expect(browser.content("https://rebind.example.com")).rejects.toThrow(/DNS-rebinding guard/);
        });

        it("refuses when the DoH lookup fails, before launching (fail closed)", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<() => Promise<Response>>(async () => {
                throw new Error("network down");
            });

            vi.stubGlobal("fetch", fetchMock);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            // The name's nameserver can stall or break the check on purpose; that must not wave the request through.
            await expect(browser.content("https://example.com")).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringMatching(/could not be verified/u),
            });
            expect(launch.browsers).toHaveLength(0);
        });

        it("bounds the DoH lookup with an abort signal and refuses when it aborts (no hang)", async () => {
            expect.hasAssertions();

            // Simulate a stalled resolver: the lookup is cut short by the abort
            // signal the factory threads in. A time-bounded lookup must always pass
            // an AbortSignal, and an abort surfaces as a refusal, not a hang.
            const fetchMock = vi.fn<(input: string, init: { signal?: AbortSignal }) => Promise<Response>>(async (_input, init) => {
                expect(init.signal).toBeInstanceOf(AbortSignal);

                throw new DOMException("The operation was aborted", "AbortError");
            });

            vi.stubGlobal("fetch", fetchMock);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await expect(browser.content("https://example.com")).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect(launch.browsers).toHaveLength(0);
        });

        it("skips the DoH round-trip for an IP-literal host", async () => {
            expect.assertions(2);

            const fetchMock = stubDohFetch({});
            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await browser.content("https://93.184.216.34");

            expect(launch.browsers).toHaveLength(1);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
    /* eslint-enable sonarjs/no-hardcoded-ip */

    /* eslint-disable sonarjs/no-clear-text-protocols -- intentional test fixtures: the redirect target is an http metadata URL asserting the interception guard aborts it; no real connection is made */
    describe("redirect-chain SSRF guard", () => {
        // Playwright never hands a redirect hop to the route handler (the fake
        // models that), so a hop is only checked if the guard fetched the
        // navigation itself and read the 3xx before anything requested its target.
        const redirectTo = (location: string) => (url: string) =>
            url === "https://public.example.com/" ? { headers: { location }, status: 302 } : { body: "<html>ok</html>", status: 200 };

        it("refuses a public URL that 302s to a private address, before the hop is requested", async () => {
            expect.assertions(2);

            const launch = fakeLaunch({ network: redirectTo("http://10.0.0.5/admin") });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://public.example.com")).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect(launch.requested).toStrictEqual(["https://public.example.com/"]);
        });

        it("refuses a redirect to the metadata endpoint the same way", async () => {
            expect.assertions(2);

            const launch = fakeLaunch({ network: redirectTo("http://169.254.169.254/latest/meta-data/") });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://public.example.com")).rejects.toThrow(/private\/internal address/u);
            expect(launch.requested).not.toContain("http://169.254.169.254/latest/meta-data/");
        });

        it("follows a redirect to another public host as a fresh, checked navigation", async () => {
            expect.assertions(2);

            const launch = fakeLaunch({ network: redirectTo("https://cdn.example.net/final") });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://public.example.com")).resolves.toContain("hi");
            expect(launch.browsers[0]!.pages[0]!.gotoCalls).toStrictEqual(["https://public.example.com/", "https://cdn.example.net/final"]);
        });

        it("resolves a relative Location against the redirecting URL", async () => {
            expect.assertions(1);

            const launch = fakeLaunch({ network: redirectTo("/next") });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("https://public.example.com");

            expect(launch.browsers[0]!.pages[0]!.gotoCalls).toStrictEqual(["https://public.example.com/", "https://public.example.com/next"]);
        });

        it("gives up after 20 redirects", async () => {
            expect.assertions(1);

            let hop = 0;
            const launch = fakeLaunch({
                network: () => {
                    hop += 1;

                    return { headers: { location: `https://loop.example.com/${String(hop)}` }, status: 302 };
                },
            });
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://loop.example.com")).rejects.toMatchObject({ code: "BROWSER_TOO_MANY_REDIRECTS", status: 502 });
        });

        it("leaves an allowlisted session's redirects to Browser Run's guardrails, which carry the list", async () => {
            expect.assertions(2);

            // With `allowedHosts`, Browser Run enforces the list on every request the
            // session makes, hops included, so the navigation is continued in the
            // browser (keeping a Tunnel-reachable internal host reachable).
            const launch = fakeLaunch();
            const browser = createBrowser({ allowedHosts: ["public.example.com"], binding: fakeBinding(), launch });

            await browser.content("https://public.example.com");

            expect(launch.launchOptions[0]).toMatchObject({ guardrails: { allowedDomains: ["public.example.com"] } });
            await expect(launch.dispatch("https://public.example.com/next", { navigation: true })).resolves.toMatchObject({ continued: true, fetched: [] });
        });
    });
    /* eslint-enable sonarjs/no-clear-text-protocols */

    describe("pdf / content / scrape", () => {
        it("pdf returns the buffer and closes the session", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            const bytes = await browser.pdf("https://example.com");

            expect(bytes).toStrictEqual(new Uint8Array([37, 80, 68, 70]));
            expect(launch.browsers[0]!.closed).toBe(1);
        });

        it("content returns the serialized html", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(browser.content("https://example.com")).resolves.toBe("<html><body>hi</body></html>");
        });

        it("scrape runs the function in the page context", async () => {
            expect.assertions(1);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            const result = await browser.scrape("https://example.com", () => 42 as never);

            expect(result).toBe(42);
        });
    });

    describe("launch escape hatch", () => {
        it("hands the browser to the callback with the guard on every context it opens, and closes it after", async () => {
            expect.assertions(3);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.launch(async (raw) => {
                const context = await raw.newContext();
                const page = await context.newPage();

                // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the private target under test; no connection is made
                await expect(page.goto("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/BLOCKEDBYCLIENT/u);
            });

            expect(launch.requested).toHaveLength(0);
            expect(launch.browsers[0]!.closed).toBe(1);
        });

        it("closes the browser even when the callback throws", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await expect(
                browser.launch(async () => {
                    throw new Error("boom");
                }),
            ).rejects.toThrow(/boom/);
            expect(launch.browsers[0]!.closed).toBe(1);
        });
    });

    describe("a failing close", () => {
        const launchWithBrokenClose = () => fakeLaunch({ closeThrows: true });

        it("does not replace the result", async () => {
            expect.assertions(1);

            const browser = createBrowser({ binding: fakeBinding(), launch: launchWithBrokenClose() });

            await expect(browser.content("https://example.com")).resolves.toContain("hi");
        });

        it("does not mask the caller's own error", async () => {
            expect.assertions(1);

            const browser = createBrowser({ binding: fakeBinding(), launch: launchWithBrokenClose() });

            await expect(
                browser.launch(async () => {
                    throw new Error("boom");
                }),
            ).rejects.toThrow(/boom/);
        });
    });

    // The workerd suite (`__tests__/workerd/`) runs the real `@cloudflare/playwright`
    // peer against a fake binding up to the DevTools upgrade. Past it — a real page
    // in a real Browser Run session — needs a deployed Worker. Tracked as a todo so
    // the gap is visible in the run summary instead of reading as covered.
    it.todo("integration harness against a real env.BROWSER (needs a deployed Worker; model on packages/hyperdrive/__tests__/create-hyperdrive.test.ts)");
});
