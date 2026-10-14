/**
 * One call to Cloudflare's account-scoped REST API
 * (`https://api.cloudflare.com/client/v4/accounts/{accountId}/…`): the bearer
 * header, and the `{ success, errors, result, … }` envelope unwrapped
 * defensively — a gateway's HTML 5xx page is not JSON, and a 200 can still
 * carry `success: false`. Callers raise their own error from a failed outcome.
 *
 * Zero-dependency and bundler-inlined (see `shared/`), shared by the Workflows
 * REST client and Browser Run's crawl client.
 */

const CLOUDFLARE_ACCOUNTS_API = "https://api.cloudflare.com/client/v4/accounts";

/** The parsed envelope of a successful call, or the status and raw body of a failed one. */
type CloudflareRestOutcome = { body: Record<string, unknown>; ok: true } | { ok: false; status: number; text: string };

interface CloudflareRestRequest {
    accountId: string;
    apiToken: string;
    /** Defaults to the global `fetch`, bound to `globalThis` so a receiver-strict runtime cannot throw "Illegal invocation". */
    fetch?: typeof fetch;
    init?: RequestInit;
    /** The path under the account, starting with `/` — e.g. `/workflows/order-pipeline/instances`. */
    path: string;
}

const cloudflareRestRequest = async ({ accountId, apiToken, fetch: fetchImpl, init, path }: CloudflareRestRequest): Promise<CloudflareRestOutcome> => {
    const response = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(`${CLOUDFLARE_ACCOUNTS_API}/${encodeURIComponent(accountId)}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    });
    const text = await response.text();
    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        return { ok: false, status: response.status, text };
    }

    if (!response.ok || typeof body !== "object" || body === null || (body as { success?: unknown }).success === false) {
        return { ok: false, status: response.status, text };
    }

    return { body: body as Record<string, unknown>, ok: true };
};

export type { CloudflareRestOutcome, CloudflareRestRequest };
export { cloudflareRestRequest };
