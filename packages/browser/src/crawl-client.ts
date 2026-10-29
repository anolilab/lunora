/**
 * Browser Run's crawl endpoint (`/browser-run/crawl`) — REST-only, with no
 * binding method — as the `crawl` / `crawlResult` / `cancelCrawl` half of
 * `ctx.browser`. Split from `create-browser.ts` so the factory stays about the
 * binding; the URL guard is injected so a crawl's starting URL passes the same
 * SSRF check as every other browser call.
 */
import { LunoraError } from "@lunora/errors";

import { capErrorBody } from "../../../shared/cap-error-body";
import { cloudflareRestRequest } from "../../../shared/cloudflare-rest";
import type { BrowserRestApiOptions, CrawlJob, CrawlOptions, CrawlResultOptions } from "./types";

interface CrawlClient {
    cancelCrawl: (jobId: string) => Promise<void>;
    crawl: (url: string, crawlOptions?: CrawlOptions) => Promise<string>;
    crawlResult: (jobId: string, resultOptions?: CrawlResultOptions) => Promise<CrawlJob>;
}

/** Package default ceilings; `createBrowser({ maxCrawlPages, maxCrawlDepth })` raises them. */
const DEFAULT_MAX_CRAWL_PAGES = 100;
const DEFAULT_MAX_CRAWL_DEPTH = 3;
/** Browser Run's own page limit when a request names none; sent explicitly so a lower `maxCrawlPages` still caps it. */
const BROWSER_RUN_DEFAULT_CRAWL_LIMIT = 10;

interface CrawlPolicy {
    allowPrivateTargets: boolean;
    hasAllowlist: boolean;
    maxCrawlDepth?: number;
    maxCrawlPages?: number;
}

const requirePositiveInteger = (name: string, value: number): number => {
    if (!Number.isInteger(value) || value < 1) {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: ${name} must be an integer >= 1, got ${String(value)}`);
    }

    return value;
};

const createCrawlClient = (
    restApi: BrowserRestApiOptions | undefined,
    { allowPrivateTargets, hasAllowlist, maxCrawlDepth = DEFAULT_MAX_CRAWL_DEPTH, maxCrawlPages = DEFAULT_MAX_CRAWL_PAGES }: CrawlPolicy,
    assertTargetAllowed: (url: string) => Promise<string>,
): CrawlClient => {
    requirePositiveInteger("maxCrawlDepth", maxCrawlDepth);
    requirePositiveInteger("maxCrawlPages", maxCrawlPages);

    const requireRestApi = (): BrowserRestApiOptions => {
        if (!restApi) {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/browser: crawling needs the Browser Run REST API — pass createBrowser({ …, restApi: { accountId, apiToken } }); /crawl has no binding method",
            );
        }

        return restApi;
    };

    /**
     * Call the crawl endpoint and return the envelope's `result`. The upstream
     * body is capped in the message (the code is client-visible) and kept whole
     * on `cause`.
     */
    const crawlRequest = async (path: string, init: RequestInit): Promise<unknown> => {
        const api = requireRestApi();
        const outcome = await cloudflareRestRequest({ accountId: api.accountId, apiToken: api.apiToken, init, path: `/browser-run/crawl${path}` });

        if (!outcome.ok) {
            throw new LunoraError("BROWSER_RUN_ERROR", `@lunora/browser: Browser Run API returned ${String(outcome.status)}: ${capErrorBody(outcome.text)}`, {
                cause: outcome.text,
                status: outcome.status >= 400 ? outcome.status : 502,
            });
        }

        return outcome.body.result;
    };

    return {
        cancelCrawl: async (jobId) => {
            await crawlRequest(`/${encodeURIComponent(jobId)}`, { method: "DELETE" });
        },
        crawl: async (url, crawlOptions = {}) => {
            requireRestApi();

            if (crawlOptions.options?.includeExternalLinks === true || crawlOptions.options?.includeSubdomains === true) {
                if (hasAllowlist) {
                    throw new LunoraError(
                        "FORBIDDEN",
                        "@lunora/browser: includeExternalLinks / includeSubdomains would crawl hosts outside the configured allowedHosts allowlist",
                    );
                }

                // Only the starting URL is validated, so an unbounded crawl needs the caller to have opted out of the SSRF guard.
                if (!allowPrivateTargets) {
                    throw new LunoraError(
                        "FORBIDDEN",
                        "@lunora/browser: includeExternalLinks / includeSubdomains would crawl hosts the SSRF guard never checks; pass createBrowser({ …, allowPrivateTargets: true }) to allow it",
                    );
                }
            }

            const target = await assertTargetAllowed(url);
            // Always sent: an omitted depth or limit would fall back to Browser Run's own
            // defaults (a depth far past `maxCrawlDepth`), not to these ceilings.
            const bounded: CrawlOptions = {
                ...crawlOptions,
                depth: crawlOptions.depth === undefined ? maxCrawlDepth : Math.min(requirePositiveInteger("depth", crawlOptions.depth), maxCrawlDepth),
                limit: Math.min(
                    crawlOptions.limit === undefined ? BROWSER_RUN_DEFAULT_CRAWL_LIMIT : requirePositiveInteger("limit", crawlOptions.limit),
                    maxCrawlPages,
                ),
            };
            const jobId = await crawlRequest("", { body: JSON.stringify({ ...bounded, url: target }), method: "POST" });

            if (typeof jobId !== "string") {
                throw new LunoraError("BROWSER_RUN_ERROR", "@lunora/browser: Browser Run accepted the crawl but returned no job id");
            }

            return jobId;
        },
        crawlResult: async (jobId, resultOptions = {}) => {
            const query = new URLSearchParams();

            for (const [key, value] of Object.entries(resultOptions)) {
                if (value !== undefined) {
                    query.set(key, String(value));
                }
            }

            const suffix = query.size === 0 ? "" : `?${query.toString()}`;
            const job = await crawlRequest(`/${encodeURIComponent(jobId)}${suffix}`, { method: "GET" });

            if (typeof job !== "object" || job === null) {
                throw new LunoraError("BROWSER_RUN_ERROR", `@lunora/browser: Browser Run returned no crawl job for "${jobId}"`);
            }

            return job as CrawlJob;
        },
    };
};

export default createCrawlClient;
