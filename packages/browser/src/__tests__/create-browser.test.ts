import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../create-browser";
import type { BrowserBindingLike, BrowserContextLike, BrowserLaunchLike, BrowserLike, PageLike, RouteLike } from "../types";

/** A throwaway binding marker — the helpers never touch it directly; Playwright consumes it. */
const fakeBinding = (): BrowserBindingLike => {
    return { fetch: () => undefined };
};

interface PageSpy extends PageLike {
    gotoCalls: string[];
    gotoOptions: ({ timeout?: number; waitUntil?: string } | undefined)[];
    screenshotCalls: Record<string, unknown>[];
    viewportCalls: { height: number; width: number }[];
}

interface BrowserSpy extends BrowserLike {
    closed: number;
    pages: PageSpy[];
}

/**
 * Build a fake `@cloudflare/playwright` `launch` whose result yields a
 * browser → context → page chain. `gotoThrows` forces `page.goto` to reject so
 * the browser-level `finally` close path can be asserted. Records every
 * goto/screenshot/viewport call and the browser close count.
 */
const fakeLaunch = (config: { gotoThrows?: boolean } = {}): BrowserLaunchLike & { browsers: BrowserSpy[] } => {
    const browsers: BrowserSpy[] = [];

    const launch = (async (_binding: BrowserBindingLike): Promise<BrowserLike> => {
        const pages: PageSpy[] = [];

        const makePage = (): PageSpy => {
            const page: PageSpy = {
                content: async () => "<html><body>hi</body></html>",
                evaluate: async (fn) => (fn as () => unknown)() as never,
                goto: async (url, gotoOptions) => {
                    page.gotoCalls.push(url);
                    page.gotoOptions.push(gotoOptions);

                    if (config.gotoThrows) {
                        throw new Error("navigation failed");
                    }

                    return undefined;
                },
                gotoCalls: [],
                gotoOptions: [],
                pdf: async () => new Uint8Array([37, 80, 68, 70]),
                screenshot: async (screenshotOptions) => {
                    page.screenshotCalls.push(screenshotOptions ?? {});

                    return new Uint8Array([137, 80, 78, 71]);
                },
                screenshotCalls: [],
                setViewportSize: async (viewport) => {
                    page.viewportCalls.push(viewport);
                },
                viewportCalls: [],
            };

            return page;
        };

        const context: BrowserContextLike = {
            newPage: async () => {
                const page = makePage();

                pages.push(page);

                return page;
            },
        };

        const browser: BrowserSpy = {
            close: async () => {
                browser.closed += 1;
            },
            closed: 0,
            newContext: async () => context,
            pages,
        };

        browsers.push(browser);

        return browser;
    }) as BrowserLaunchLike & { browsers: BrowserSpy[] };

    launch.browsers = browsers;

    return launch;
};

describe("createBrowser", () => {
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
    });

    /* eslint-disable sonarjs/no-hardcoded-ip -- intentional test fixtures: these are DoH-resolved IPs asserting the rebinding guard classifies them; no real connection is made */
    describe("resolveDns rebinding re-check", () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        type DohAnswer = { data: string; type: number };
        type FetchStub = (input: string) => Promise<Response>;

        /** Stub global `fetch` to answer Cloudflare DoH JSON by the requested record `type`. */
        const stubDohFetch = (answersByType: Record<number, DohAnswer[]>): ReturnType<typeof vi.fn<FetchStub>> => {
            const fetchMock = vi.fn<FetchStub>(async (input) => {
                const type = Number(new URL(input).searchParams.get("type"));

                return {
                    json: async () => {
                        return { Answer: answersByType[type] ?? [] };
                    },
                    ok: true,
                } as unknown as Response;
            });

            vi.stubGlobal("fetch", fetchMock);

            return fetchMock;
        };

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

        it("falls back to the string guard (allows) when the DoH lookup fails", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<() => Promise<Response>>(async () => {
                throw new Error("network down");
            });

            vi.stubGlobal("fetch", fetchMock);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await browser.content("https://example.com");

            expect(launch.browsers).toHaveLength(1);
        });

        it("bounds the DoH lookup with an abort signal and falls back when it aborts (no hang)", async () => {
            expect.hasAssertions();

            // Simulate a stalled resolver: the lookup is cut short by the abort
            // signal the factory now threads in. A time-bounded lookup must always
            // pass an AbortSignal, and an abort surfaces as a rejection → the guard
            // falls back to the (already-passed) string guard instead of hanging.
            const fetchMock = vi.fn<(input: string, init: { signal?: AbortSignal }) => Promise<Response>>(async (_input, init) => {
                expect(init.signal).toBeInstanceOf(AbortSignal);

                throw new DOMException("The operation was aborted", "AbortError");
            });

            vi.stubGlobal("fetch", fetchMock);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch, resolveDns: true });

            await browser.content("https://example.com");

            expect(launch.browsers).toHaveLength(1);
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
    describe("redirect-chain SSRF guard (page.route)", () => {
        interface RedirectSpy {
            aborted: string[];
            continued: string[];
        }

        /** A fake Playwright `Route` for a simulated main-frame redirect to `redirectTo`, recording abort/continue on `events`. */
        const buildRoute = (redirectTo: string, events: RedirectSpy): RouteLike => {
            return {
                abort: async () => {
                    events.aborted.push(redirectTo);
                },
                continue: async () => {
                    events.continued.push(redirectTo);
                },
                request: () => {
                    return { isNavigationRequest: () => true, url: () => redirectTo };
                },
            };
        };

        /**
         * A launch whose page captures the `page.route` handler and, on `goto`,
         * fires it once with a simulated main-frame redirect to `redirectTo` — so
         * the interception guard can be exercised without a real browser. Records
         * whether the intercepted redirect was aborted or continued.
         */
        const redirectingLaunch = (redirectTo: string): BrowserLaunchLike & { events: RedirectSpy } => {
            const events: RedirectSpy = { aborted: [], continued: [] };
            let routeHandler: ((route: RouteLike) => unknown) | undefined;

            const page: PageLike = {
                content: async () => "<html>ok</html>",
                evaluate: async () => undefined as never,
                // Simulate the browser following a 3xx: replay the redirect target through the registered interceptor.
                goto: async () => routeHandler?.(buildRoute(redirectTo, events)),
                pdf: async () => new Uint8Array(),
                route: async (_pattern, handler) => {
                    routeHandler = handler;
                },
                screenshot: async () => new Uint8Array(),
            };

            const context: BrowserContextLike = { newPage: async () => page };
            const browser: BrowserLike = { close: async () => {}, newContext: async () => context };
            const launch = (async (_binding: BrowserBindingLike) => browser) as BrowserLaunchLike & { events: RedirectSpy };

            launch.events = events;

            return launch;
        };

        it("aborts a redirect to a private/metadata host", async () => {
            expect.assertions(2);

            const launch = redirectingLaunch("http://169.254.169.254/latest/meta-data/");
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("https://public.example.com");

            expect(launch.events.aborted).toStrictEqual(["http://169.254.169.254/latest/meta-data/"]);
            expect(launch.events.continued).toHaveLength(0);
        });

        it("allows a redirect to another public host", async () => {
            expect.assertions(2);

            const launch = redirectingLaunch("https://cdn.example.net/final");
            const browser = createBrowser({ binding: fakeBinding(), launch });

            await browser.content("https://public.example.com");

            expect(launch.events.continued).toStrictEqual(["https://cdn.example.net/final"]);
            expect(launch.events.aborted).toHaveLength(0);
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
        it("hands the raw browser to the callback and closes it after", async () => {
            expect.assertions(2);

            const launch = fakeLaunch();
            const browser = createBrowser({ binding: fakeBinding(), launch });

            const handle = await browser.launch(async (raw) => raw);

            expect(launch.browsers[0]).toBe(handle);
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

    // Real `env.BROWSER` coverage is deliberately absent: workerd + the Browser
    // Rendering binding require Cloudflare's edge (see vitest.config.ts), and a
    // local harness would only re-mock what the fake-double suite above already
    // covers. Tracked as a todo so the gap is visible in the run summary
    // instead of reading as a green "live playwright" block.
    it.todo("integration harness against a real env.BROWSER (needs a deployed Worker; model on packages/hyperdrive/__tests__/create-hyperdrive.test.ts)");
});
