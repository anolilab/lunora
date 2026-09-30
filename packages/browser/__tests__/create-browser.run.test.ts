/* eslint-disable sonarjs/no-clear-text-protocols -- SSRF fixtures deliberately target http:// private hosts */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowser } from "../src/create-browser";
import type { BrowserBindingLike, BrowserLaunchLike, QuickActionName } from "../src/types";
import { stubDohFetch } from "./_helpers/stub-doh";

/* eslint-disable vitest/require-top-level-describe -- every describe below stubs `fetch` */
afterEach(() => {
    vi.unstubAllGlobals();
});
/* eslint-enable vitest/require-top-level-describe */

const plainBinding: BrowserBindingLike = { fetch: async () => new Response() };

const makeQuickBinding = () => {
    const quickAction = vi.fn<(action: QuickActionName, options: { url: string }) => Promise<Response>>(async () => Response.json({ success: true }));

    return { binding: { fetch: async () => new Response(), quickAction } as BrowserBindingLike, quickAction };
};

describe("quickAction", () => {
    it("guards URLs nested in the options (addScriptTag / addStyleTag), not only the target", async () => {
        expect.assertions(3);

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ allowedHosts: ["example.com", "cdn.example.com"], binding, launch: async () => ({}) as never });

        await browser.quickAction("screenshot", "https://example.com", { addScriptTag: [{ url: "https://cdn.example.com/a.js" }] });

        expect(quickAction.mock.calls[0]![1]).toMatchObject({ addScriptTag: [{ url: "https://cdn.example.com/a.js" }], url: "https://example.com/" });

        await expect(browser.quickAction("screenshot", "https://example.com", { addStyleTag: [{ url: "https://evil.test/x.css" }] })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(quickAction).toHaveBeenCalledTimes(1);
    });

    it("forwards the action and the validated url to the binding", async () => {
        expect.assertions(2);

        stubDohFetch();

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ binding });

        const response = await browser.quickAction("snapshot", "https://example.com", { formats: ["markdown", "accessibilityTree"] });

        expect(response.ok).toBe(true);
        expect(quickAction).toHaveBeenCalledWith("snapshot", { formats: ["markdown", "accessibilityTree"], url: "https://example.com/" });
    });

    it("refuses a private target before calling the binding", async () => {
        expect.assertions(2);

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ binding });

        await expect(browser.quickAction("markdown", "http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private\/internal address/u);
        expect(quickAction).not.toHaveBeenCalled();
    });

    it("refuses an off-allowlist host", async () => {
        expect.assertions(2);

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ allowedHosts: ["example.com"], binding });

        await expect(browser.quickAction("accessibilityTree", "https://evil.example.net")).rejects.toThrow(/not in the configured allowedHosts/u);
        expect(quickAction).not.toHaveBeenCalled();
    });

    it("applies the DNS-rebinding re-check", async () => {
        expect.assertions(2);

        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private A record fixture
        stubDohFetch({ 1: [{ data: "10.0.0.1", type: 1 }], 28: [] });

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ binding });

        await expect(browser.quickAction("links", "https://rebind.example.com")).rejects.toThrow(/DNS-rebinding guard/u);
        expect(quickAction).not.toHaveBeenCalled();
    });

    it("rejects inline html, which no URL guard could inspect", async () => {
        expect.assertions(2);

        const { binding, quickAction } = makeQuickBinding();
        const browser = createBrowser({ binding });

        await expect(browser.quickAction("screenshot", "https://example.com", { html: "<img src=http://10.0.0.1>" } as never)).rejects.toThrow(/not `html`/u);
        expect(quickAction).not.toHaveBeenCalled();
    });

    it("names the missing binding method", async () => {
        expect.assertions(1);

        const browser = createBrowser({ binding: plainBinding });

        await expect(browser.quickAction("markdown", "https://example.com")).rejects.toThrow(/no `quickAction` method/u);
    });
});

describe("guardrails", () => {
    const captureLaunch = () => {
        const calls: (Record<string, unknown> | undefined)[] = [];
        const launch: BrowserLaunchLike = async (_binding, options) => {
            calls.push(options);

            return {
                close: async () => {},
                newContext: async () => {
                    return { newPage: async () => ({}) as never };
                },
            };
        };

        return { calls, launch };
    };

    it("forwards allowedHosts as normalized session guardrails, even to the raw launch escape hatch", async () => {
        expect.assertions(1);

        const { calls, launch } = captureLaunch();
        const browser = createBrowser({ allowedHosts: ["Example.COM.", "cdn.example.com"], binding: plainBinding, launch });

        await browser.launch(async () => "ok", { keepAlive: 60 });

        expect(calls[0]).toStrictEqual({ guardrails: { allowedDomains: ["example.com", "cdn.example.com"] }, keep_alive: 60_000 });
    });

    it("forwards an empty allowlist as block-everything guardrails", async () => {
        expect.assertions(1);

        const { calls, launch } = captureLaunch();
        const browser = createBrowser({ allowedHosts: [], binding: plainBinding, launch });

        await browser.launch(async () => "ok");

        expect(calls[0]).toStrictEqual({ guardrails: { allowedDomains: [] } });
    });

    it("refuses more hosts than Browser Run guardrails accept, at createBrowser", () => {
        expect.assertions(2);

        const { calls, launch } = captureLaunch();
        const allowedHosts = Array.from({ length: 51 }, (_, index) => `h${String(index)}.example.com`);

        expect(() => createBrowser({ allowedHosts, binding: plainBinding, launch })).toThrow(/at most 50/u);
        expect(calls).toHaveLength(0);
    });

    it("refuses a wildcard entry, which guardrails would widen past the exact-match allowlist", () => {
        expect.assertions(2);

        const { calls, launch } = captureLaunch();

        expect(() => createBrowser({ allowedHosts: ["example.com", "*"], binding: plainBinding, launch })).toThrow(/contains "\*"/u);
        expect(calls).toHaveLength(0);
    });
});

describe("crawl", () => {
    const restApi = { accountId: "acc-1", apiToken: "token-1" };
    const crawlEndpoint = "https://api.cloudflare.com/client/v4/accounts/acc-1/browser-run/crawl";

    /** Answer DoH with a public record and the crawl API with `crawlResponse`. */
    const stubFetch = (crawlResponse: () => Response) => {
        const crawlCalls: { init: RequestInit; url: string }[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string, init?: RequestInit) => {
                if (input.startsWith("https://cloudflare-dns.com/")) {
                    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- public A record fixture
                    return Response.json({ Answer: new URL(input).searchParams.get("type") === "1" ? [{ data: "93.184.216.34", type: 1 }] : [] });
                }

                crawlCalls.push({ init: init ?? {}, url: input });

                return crawlResponse();
            }),
        );

        return crawlCalls;
    };

    it("starts a crawl with the validated url and returns the job id", async () => {
        expect.assertions(4);

        const calls = stubFetch(() => Response.json({ result: "job-1", success: true }));
        const browser = createBrowser({ binding: plainBinding, restApi });

        await expect(browser.crawl("https://example.com", { contentUse: "reference", formats: ["markdown"] })).resolves.toBe("job-1");

        expect(calls[0]?.url).toBe(crawlEndpoint);
        expect(calls[0]?.init.method).toBe("POST");
        expect(JSON.parse(calls[0]?.init.body as string)).toStrictEqual({ contentUse: "reference", formats: ["markdown"], url: "https://example.com/" });
    });

    it("refuses a private starting url without calling the API", async () => {
        expect.assertions(2);

        const calls = stubFetch(() => Response.json({ result: "job-1", success: true }));
        const browser = createBrowser({ binding: plainBinding, restApi });

        await expect(browser.crawl("http://10.0.0.1/")).rejects.toThrow(/private\/internal address/u);
        expect(calls).toHaveLength(0);
    });

    it("refuses to leave the allowlist through external links or subdomains", async () => {
        expect.assertions(3);

        const calls = stubFetch(() => Response.json({ result: "job-1", success: true }));
        const browser = createBrowser({ allowedHosts: ["example.com"], binding: plainBinding, restApi });

        await expect(browser.crawl("https://example.com", { options: { includeExternalLinks: true } })).rejects.toThrow(/outside the configured allowedHosts/u);
        await expect(browser.crawl("https://example.com", { options: { includeSubdomains: true } })).rejects.toThrow(/outside the configured allowedHosts/u);
        expect(calls).toHaveLength(0);
    });

    it("reads a job page with its query and cancels by id", async () => {
        expect.assertions(4);

        const job = { finished: 1, id: "job/1", records: [], status: "running", total: 3 };
        const calls = stubFetch(() => Response.json({ result: job, success: true }));
        const browser = createBrowser({ binding: plainBinding, restApi });

        await expect(browser.crawlResult("job/1", { cursor: 10, limit: 5, status: "completed" })).resolves.toStrictEqual(job);

        await browser.cancelCrawl("job/1");

        // eslint-disable-next-line no-secrets/no-secrets -- a URL query string, not a credential
        expect(calls[0]?.url).toBe(`${crawlEndpoint}/job%2F1?cursor=10&limit=5&status=completed`);
        expect(calls[1]?.init.method).toBe("DELETE");
        expect(calls[1]?.url).toBe(`${crawlEndpoint}/job%2F1`);
    });

    it("surfaces an upstream failure with its status, body capped", async () => {
        expect.assertions(2);

        stubFetch(() => Response.json({ errors: [{ message: "robots.txt disallows" }], success: false }, { status: 400 }));
        const browser = createBrowser({ binding: plainBinding, restApi });

        const error = await browser.crawl("https://example.com").catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "BROWSER_RUN_ERROR", status: 400 });
        expect((error as Error).message).toMatch(/returned 400: .*robots\.txt disallows/u);
    });

    it("needs restApi", async () => {
        expect.assertions(1);

        const browser = createBrowser({ binding: plainBinding });

        await expect(browser.crawlResult("job-1")).rejects.toThrow(/restApi/u);
    });
});
