/**
 * Cloudflare REST API port for the control plane's own account work: D1 export
 * for backups and Cloudflare-for-SaaS custom hostnames. Tenant provisioning is
 * not here — it runs through Alchemy in the provision box (the `cloudflare-wfp`
 * driver, `src/targets/cloudflare-wfp/`).
 *
 * The HTTP implementation ({@link createHttpCloudflareApi}) calls the
 * documented REST endpoints under `https://api.cloudflare.com/client/v4`.
 */

import stripTrailingSlashes from "../lib/strip-trailing-slashes";

export interface CloudflareApi {
    /** Create a Cloudflare-for-SaaS custom hostname for a tenant domain (§4). */
    createCustomHostname: (input: { hostname: string; zoneId: string }) => Promise<{ id: string }>;

    /**
     * Start a full SQL export of a D1 database and poll it to completion, then
     * answer the presigned URL of the dump. The URL is valid for one hour.
     */
    exportD1Database: (databaseId: string) => Promise<{ signedUrl: string }>;
}

export interface HttpCloudflareApiOptions {
    accountId: string;
    apiToken: string;
    /** Override for tests; defaults to the public API base. */
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
}

interface CloudflareEnvelope {
    errors?: { code?: number; message?: string }[];
    result?: unknown;
    success?: boolean;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/** D1's export endpoint answers a progress report inside the account envelope, not the dump. */
interface D1ExportResponse {
    at_bookmark?: string;
    error?: string;
    messages?: string[];
    result?: { signed_url?: string };
    status?: string;
    success?: boolean;
}

/** Bounds the export poll so a stuck run degrades into a failed backup, not a hung cron. */
const MAX_EXPORT_POLLS = 30;
const EXPORT_POLL_INTERVAL_MS = 2000;

/**
 * HTTP implementation of {@link CloudflareApi}. Real code against the documented
 * REST endpoints; supply an account id + a scoped API token to run it.
 */
export const createHttpCloudflareApi = (options: HttpCloudflareApiOptions): CloudflareApi => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiRoot = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE);
    const base = `${apiRoot}/accounts/${options.accountId}`;
    const authHeader = `Bearer ${options.apiToken}`;

    const callAt = async (fullUrl: string, method: string, body: unknown): Promise<unknown> => {
        const response = await fetchImpl(fullUrl, {
            body: JSON.stringify(body),
            headers: { authorization: authHeader, "content-type": "application/json" },
            method,
        });
        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope;

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare ${method} ${fullUrl} failed: ${message}`);
        }

        return envelope.result;
    };

    const callJson = async (path: string, method: string, body: unknown): Promise<unknown> => {
        const response = await fetchImpl(`${base}${path}`, {
            body: JSON.stringify(body),
            headers: { authorization: authHeader, "content-type": "application/json" },
            method,
        });
        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope;

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare ${method} ${path} failed: ${message}`);
        }

        return envelope.result;
    };

    return {
        createCustomHostname: async ({ hostname, zoneId }) => {
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/custom_hostnames`, "POST", { hostname, ssl: { method: "http", type: "dv" } })) as {
                id?: string;
            };

            if (!result.id) {
                throw new Error("cloudflare custom hostname create returned no id");
            }

            return { id: result.id };
        },
        exportD1Database: async (databaseId) => {
            // Two-phase, per D1's REST contract: the first POST starts the export
            // and answers `status: "active"` with a bookmark, and each subsequent
            // POST carrying that bookmark reports progress until `"complete"`,
            // when `result.signed_url` appears. Passing the bookmark back is what
            // identifies the run — omitting it starts a second export.
            let bookmark: string | undefined;

            for (let attempt = 0; attempt < MAX_EXPORT_POLLS; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- polling is sequential by definition
                const response = (await callJson(`/d1/database/${databaseId}/export`, "POST", {
                    ...(bookmark === undefined ? {} : { current_bookmark: bookmark }),
                    dump_options: { no_data: false, no_schema: false, tables: [] },
                    output_format: "polling",
                })) as D1ExportResponse;

                if (response.status === "error" || response.success === false) {
                    throw new Error(`cloudflare D1 export failed: ${response.error ?? response.messages?.join("; ") ?? "unknown error"}`);
                }

                if (response.status === "complete") {
                    const signedUrl = response.result?.signed_url;

                    if (!signedUrl) {
                        throw new Error("cloudflare D1 export completed without a signed_url");
                    }

                    return { signedUrl };
                }

                bookmark = response.at_bookmark;

                // eslint-disable-next-line no-await-in-loop -- deliberate backoff between polls
                await new Promise((resolve) => {
                    setTimeout(resolve, EXPORT_POLL_INTERVAL_MS);
                });
            }

            throw new Error(`cloudflare D1 export did not complete within ${String(MAX_EXPORT_POLLS)} polls`);
        },
    };
};
