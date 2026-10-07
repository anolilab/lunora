/**
 * `@lunora/browser` in real workerd.
 *
 * The Node suite drives `createBrowser` over plain-object doubles. This one runs
 * it on the runtime it ships to, against the real `@cloudflare/playwright` peer,
 * with `env.BROWSER` a real service binding to a fake Browser Run (see
 * `test-worker.ts`), and every global `fetch` leaving workerd for a fake internet
 * (`fake-internet.ts`, wired as miniflare's `outboundService`).
 *
 * Verified here: the real `launch` / `connect` / `sessions` exports load in
 * workerd and put what `createBrowser` asked for on the wire to the binding
 * (`keep_alive` in milliseconds, `allowedHosts` as normalized session guardrails
 * at acquire, the session id on a re-attach); `quickAction` crosses the binding's
 * RPC boundary with the guarded URL; the DoH re-check and the `/crawl` REST
 * client run on workerd's own `fetch`, and the operation deadline and the DoH
 * ceiling on its timers and `AbortSignal.timeout`.
 *
 * Not verified anywhere in this repo: anything past the DevTools WebSocket. The
 * fake refuses the upgrade because there is no Chrome behind it, so navigation,
 * screenshots, PDFs, `scrape` and the redirect guard against a real page are
 * covered only by the Node suite's page doubles, and the provider's own
 * enforcement of guardrails and `keep_alive` only by Cloudflare.
 */
import { connect, launch, sessions } from "@cloudflare/playwright";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../../src/create-browser";
import type { BrowserLaunchLike, BrowserLike } from "../../src/types";
import { fakeLaunch } from "../_helpers/fake-launch";
import { SESSION_ID } from "./test-worker";

const binding = env.BROWSER;

const fetchCalls = async () => {
    const calls = await binding.recorded();

    return calls.filter((call) => call.kind === "fetch");
};

describe("@lunora/browser (workerd)", () => {
    beforeEach(async () => {
        await binding.reset();
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
            // The upgrade attaches to the acquired session, so it carries no guardrails
            // header: they were latched at acquire, for the session's lifetime.
            expect(upgrade).toMatchObject({ guardrailsHeader: undefined, path: `/v1/devtools/browser/${SESSION_ID}`, upgrade: "websocket" });
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
        it("aborts a trapped operation at the deadline and closes the session", async () => {
            expect.hasAssertions();

            const launchDouble = fakeLaunch({ page: { evaluate: async () => new Promise<never>(() => {}) } });
            const browser = createBrowser({ allowedHosts: ["example.com"], binding, launch: launchDouble });

            await expect(browser.scrape("https://example.com", () => document.title, { timeoutMs: 50 })).rejects.toMatchObject({
                code: "BROWSER_TIMEOUT",
                status: 504,
            });
            expect(launchDouble.browsers[0]!.closed).toBe(1);
        });

        it("refuses a public name that resolves to a private address, before launching", async () => {
            expect.hasAssertions();

            const launchSpy = vi.fn<BrowserLaunchLike>();
            const browser = createBrowser({ binding, launch: launchSpy });

            await expect(browser.content("https://rebind.example")).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringMatching(/resolves to a private\/internal address \(10\.0\.0\.7\)/u),
            });
            expect(launchSpy).not.toHaveBeenCalled();
        });

        it("refuses a name whose lookup answers SERVFAIL", async () => {
            expect.hasAssertions();

            const launchSpy = vi.fn<BrowserLaunchLike>();
            const browser = createBrowser({ binding, launch: launchSpy });

            await expect(browser.content("https://servfail.example")).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringMatching(/did not resolve to any address/u),
            });
            expect(launchSpy).not.toHaveBeenCalled();
        });

        it("falls back to the string guard when a stalled DoH lookup hits its ceiling", async () => {
            expect.hasAssertions();

            // The fake internet answers this name only after 1.5s; the factory's 200ms
            // budget caps the lookup, AbortSignal.timeout ends it, and the call proceeds.
            const browser = createBrowser({ binding, timeoutMs: 200 });
            const started = Date.now();

            const response = await browser.quickAction("markdown", "https://slow-dns.example");

            expect(response.ok).toBe(true);
            expect(Date.now() - started).toBeLessThan(1500);
        });

        it("surfaces a /crawl API failure as BROWSER_RUN_ERROR with the upstream status", async () => {
            expect.hasAssertions();

            const browser = createBrowser({ allowedHosts: ["example.com"], binding, restApi: { accountId: "acc", apiToken: "token" } });

            await expect(browser.crawl("https://example.com")).rejects.toMatchObject({ code: "BROWSER_RUN_ERROR", status: 429 });
        });
    });
});
