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

const createCrawlClient = (
    restApi: BrowserRestApiOptions | undefined,
    hasAllowlist: boolean,
    assertTargetAllowed: (url: string) => Promise<string>,
): CrawlClient => {
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

            if (hasAllowlist && (crawlOptions.options?.includeExternalLinks === true || crawlOptions.options?.includeSubdomains === true)) {
                throw new LunoraError(
                    "FORBIDDEN",
                    "@lunora/browser: includeExternalLinks / includeSubdomains would crawl hosts outside the configured allowedHosts allowlist",
                );
            }

            const target = await assertTargetAllowed(url);
            const jobId = await crawlRequest("", { body: JSON.stringify({ ...crawlOptions, url: target }), method: "POST" });

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
