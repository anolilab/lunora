/**
 * `@lunora/browser` in real workerd.
 *
 * The Node suite drives `createBrowser` over plain-object doubles. This one runs
 * it on the runtime it ships to, against the real `@cloudflare/playwright` peer,
 * with `env.BROWSER` a real service binding to a fake Browser Run (see
 * `test-worker.ts`).
 *
 * Verified here: the real `launch` / `connect` / `sessions` exports load in
 * workerd and put what `createBrowser` asked for on the wire to the binding
 * (`keep_alive` in milliseconds, `allowedHosts` as normalized session guardrails,
 * the session id on a re-attach); `quickAction` crosses the binding's RPC
 * boundary with the guarded URL, and an off-allowlist nested URL never reaches
 * it; workerd's timers and `AbortSignal.timeout` drive the operation deadline and
 * the DoH lookup ceiling, and its `fetch` the DoH re-check and the `/crawl` REST
 * client.
 *
 * Not verified anywhere in this repo: anything past the DevTools WebSocket. The
 * fake refuses the upgrade because there is no Chrome behind it, so navigation,
 * screenshots, PDFs, `scrape` and the `page.route` redirect guard against a real
 * page are covered only by the Node suite's page doubles, and the provider's own
 * enforcement of guardrails and `keep_alive` only by Cloudflare.
 */
import { connect, launch, sessions } from "@cloudflare/playwright";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../../src/create-browser";
import type { BrowserLaunchLike, BrowserLike, PageLike } from "../../src/types";
import { SESSION_ID } from "./test-worker";

const binding = env.BROWSER;

const fetchCalls = async () => {
    const calls = await binding.recorded();

    return calls.filter((call) => call.kind === "fetch");
};

/** Resolve DoH lookups for every host to `address` (an A record). */
const stubDoh = (address: string): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => Response.json({ Answer: [{ data: address, type: 1 }] })),
    );
};

describe("@lunora/browser (workerd)", () => {
    beforeEach(async () => {
        await binding.reset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("the real @cloudflare/playwright peer against the binding", () => {
        it("acquires with keep_alive in milliseconds and allowedHosts as normalized guardrails", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ allowedHosts: ["Example.COM."], binding, launch });
            const run = vi.fn<(browser: BrowserLike) => Promise<void>>();

            // The fake has no Chrome, so the DevTools upgrade is refused and launch fails there.
            await expect(browser.launch(run, { keepAlive: 600 })).rejects.toThrow(/Unable to connect to browser: code: 503/u);
            expect(run).not.toHaveBeenCalled();

            const [acquire, upgrade] = await fetchCalls();

            expect(acquire).toMatchObject({
                body: { guardrails: { allowedDomains: ["example.com"] } },
                method: "POST",
                path: "/v1/devtools/browser?keep_alive=600000",
            });
            // The upgrade attaches to the acquired session; guardrails were latched at acquire.
            expect(upgrade).toMatchObject({ path: `/v1/devtools/browser/${SESSION_ID}`, upgrade: "websocket" });
        });

        it("refuses a keepAlive outside Browser Run's window before touching the binding", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ allowedHosts: ["example.com"], binding, launch });

            await expect(browser.launch(async () => undefined, { keepAlive: 3600 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(fetchCalls()).resolves.toHaveLength(0);
        });

        it("lists sessions through the binding", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ binding, sessions });

            await expect(browser.sessions()).resolves.toStrictEqual([{ sessionId: SESSION_ID, startTime: 1 }]);
            await expect(fetchCalls()).resolves.toMatchObject([{ method: "GET", path: "/v1/sessions" }]);
        });

        it("re-attaches to the named session on connect", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ binding, connect });

            await expect(browser.connect(SESSION_ID, async () => undefined)).rejects.toThrow(/Unable to connect to browser/u);
            await expect(fetchCalls()).resolves.toMatchObject([{ path: `/v1/devtools/browser/${SESSION_ID}`, upgrade: "websocket" }]);
        });

        it("refuses a private target before any request reaches the binding", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ binding, launch });

            // eslint-disable-next-line sonarjs/no-clear-text-protocols -- an SSRF fixture: the cloud-metadata endpoint is plain http
            await expect(browser.screenshot("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "FORBIDDEN" });
            await expect(fetchCalls()).resolves.toHaveLength(0);
        });
    });

    describe("quickAction over the binding's RPC boundary", () => {
        it("forwards the guarded url and the options intact", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ allowedHosts: ["example.com"], binding });

            const response = await browser.quickAction("snapshot", "https://EXAMPLE.com", {
                addScriptTag: [{ url: "https://example.com/a.js" }],
                formats: ["markdown", "accessibilityTree"],
            });

            await expect(response.json()).resolves.toStrictEqual({ result: { action: "snapshot", url: "https://example.com/" }, success: true });
            await expect(binding.recorded()).resolves.toStrictEqual([
                {
                    body: {
                        action: "snapshot",
                        options: {
                            addScriptTag: [{ url: "https://example.com/a.js" }],
                            formats: ["markdown", "accessibilityTree"],
                            url: "https://example.com/",
                        },
                    },
                    kind: "quickAction",
                },
            ]);
        });

        it("never calls the binding when a nested url is off the allowlist", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ allowedHosts: ["example.com"], binding });

            await expect(browser.quickAction("screenshot", "https://example.com", { addStyleTag: [{ url: "https://evil.test/x.css" }] })).rejects.toMatchObject(
                {
                    code: "FORBIDDEN",
                },
            );
            await expect(binding.recorded()).resolves.toHaveLength(0);
        });
    });

    describe("workerd timers and fetch", () => {
        /** A launch double over one page, counting closes through `close`. */
        const launchOver = (page: Partial<PageLike>, close: () => Promise<void>): BrowserLaunchLike => {
            const full: PageLike = {
                content: async () => "",
                evaluate: async () => {
                    throw new Error("not driven by this test");
                },
                goto: async () => undefined,
                pdf: async () => new Uint8Array(),
                screenshot: async () => new Uint8Array(),
                ...page,
            };

            return async () => {
                return {
                    close,
                    newContext: async () => {
                        return { newPage: async () => full };
                    },
                };
            };
        };

        it("aborts a trapped operation at the deadline and closes the session", async () => {
            expect.hasAssertions();

            const close = vi.fn<() => Promise<void>>(async () => undefined);
            const browser = createBrowser({
                allowedHosts: ["example.com"],
                binding,
                launch: launchOver({ evaluate: async () => new Promise<never>(() => {}) }, close),
            });

            await expect(browser.scrape("https://example.com", () => document.title, { timeoutMs: 50 })).rejects.toMatchObject({
                code: "BROWSER_TIMEOUT",
                status: 504,
            });
            expect(close).toHaveBeenCalledTimes(1);
        });

        it("refuses a public name that resolves to a private address, before launching", async () => {
            expect.hasAssertions();

            // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private address the rebinding guard must refuse; no connection is made
            stubDoh("10.0.0.7");

            const launchSpy = vi.fn<BrowserLaunchLike>();
            const browser = createBrowser({ binding, launch: launchSpy });

            await expect(browser.content("https://rebind.example")).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringMatching(/DNS-rebinding/u),
            });
            expect(launchSpy).not.toHaveBeenCalled();
        });

        it("falls back to the string guard when a stalled DoH lookup hits its ceiling", async () => {
            expect.hasAssertions();

            // Never answers; only the lookup's own AbortSignal.timeout can end it.
            vi.stubGlobal(
                "fetch",
                vi.fn<typeof fetch>(
                    async (_input, init) =>
                        new Promise<Response>((_resolve, reject) => {
                            init?.signal?.addEventListener("abort", () => {
                                reject(new DOMException("The operation timed out.", "TimeoutError"));
                            });
                        }),
                ),
            );

            const close = vi.fn<() => Promise<void>>(async () => undefined);
            const launchSpy = vi.fn<BrowserLaunchLike>(launchOver({ content: async () => "<html></html>" }, close));
            const browser = createBrowser({ binding, launch: launchSpy, timeoutMs: 200 });

            await expect(browser.content("https://slow-dns.example")).resolves.toBe("<html></html>");
            expect(close).toHaveBeenCalledTimes(1);
        });

        it("surfaces a /crawl API failure as BROWSER_RUN_ERROR with the upstream status", async () => {
            expect.hasAssertions();

            vi.stubGlobal(
                "fetch",
                vi.fn<typeof fetch>(async () => Response.json({ errors: [{ message: "rate limited" }], success: false }, { status: 429 })),
            );

            const browser = createBrowser({ allowedHosts: ["example.com"], binding, restApi: { accountId: "acc", apiToken: "token" } });

            await expect(browser.crawl("https://example.com")).rejects.toMatchObject({ code: "BROWSER_RUN_ERROR", status: 429 });
        });
    });
});
