/**
 * Cloudflare REST API port for the control plane's own account work: D1 export
 * for backups, Cloudflare-for-SaaS custom hostnames (the platform's SaaS zone,
 * `LUNORA_SAAS_ZONE_ID`), and the DNS records of the
 * platform's own box zone (`LUNORA_BOX_ZONE_ID`, plan 458 G13). Tenant
 * provisioning is not here — it runs through Alchemy in the provision box (the
 * `cloudflare-wfp` driver, `src/targets/cloudflare-wfp/`).
 *
 * The HTTP implementation ({@link createHttpCloudflareApi}) calls the
 * documented REST endpoints under `https://api.cloudflare.com/client/v4`.
 */

import stripTrailingSlashes from "../lib/strip-trailing-slashes";

/**
 * A Cloudflare-for-SaaS custom hostname as the API reports it: its id, the
 * hostname's own status, and its certificate's (`ssl.status` — `initializing`,
 * `pending_validation`, `pending_issuance`, `pending_deployment`, `active`, …).
 * `errors` are the validation errors Cloudflare reports for either, verbatim.
 */
export interface CustomHostname {
    errors: string[];
    hostname: string;
    id: string;
    sslStatus: string;
    status: string;
}

/** One DNS record of a zone, as the API lists it. */
export interface DnsRecord {
    content: string;
    id: string;
    name: string;
    type: string;
}

export interface CloudflareApi {
    /** Create a Cloudflare-for-SaaS custom hostname for a tenant domain (GAPS.md B1): DV certificate, HTTP validation. */
    createCustomHostname: (input: { hostname: string; zoneId: string }) => Promise<CustomHostname>;

    /** Create one DNS-only (unproxied) record. */
    createDnsRecord: (input: { content: string; name: string; type: "A" | "AAAA"; zoneId: string }) => Promise<{ id: string }>;

    /** Delete a custom hostname (and with it its certificate). `false` when there was none to delete. */
    deleteCustomHostname: (input: { id: string; zoneId: string }) => Promise<boolean>;

    /** Delete one DNS record by id. */
    deleteDnsRecord: (input: { id: string; zoneId: string }) => Promise<void>;

    /**
     * Start a full SQL export of a D1 database and poll it to completion, then
     * answer the presigned URL of the dump. The URL is valid for one hour.
     */
    exportD1Database: (databaseId: string) => Promise<{ signedUrl: string }>;

    /** The custom hostname named exactly `hostname`, or `null` — what makes issuing one idempotent. */
    findCustomHostname: (input: { hostname: string; zoneId: string }) => Promise<CustomHostname | null>;

    /** One custom hostname by id, or `null` once it is gone. */
    getCustomHostname: (input: { id: string; zoneId: string }) => Promise<CustomHostname | null>;

    /** The records named exactly `name` (any type) — what makes the box DNS writes idempotent. */
    listDnsRecords: (input: { name: string; zoneId: string }) => Promise<DnsRecord[]>;

    /**
     * Every record whose name ends in `.{domain}` (any type), across all pages —
     * what the box DNS reconcile sweep diffs against the `boxes` table. Bounded:
     * it stops after {@link MAX_DNS_LIST_PAGES} pages and says so with `truncated`,
     * rather than reading a runaway zone forever.
     */
    listDnsRecordsUnder: (input: { domain: string; zoneId: string }) => Promise<{ records: DnsRecord[]; truncated: boolean }>;
}

/** Records per page of a DNS listing — the API's maximum. */
const DNS_PAGE_SIZE = 100;

/** Pages {@link CloudflareApi.listDnsRecordsUnder} reads at most: 5,000 records, two per address family per box. */
export const MAX_DNS_LIST_PAGES = 50;

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

/** A custom hostname as the API returns it — only the fields the port reads. */
interface CustomHostnameResult {
    hostname?: string;
    id?: string;
    ssl?: { status?: string; validation_errors?: { message?: string }[] };
    status?: string;
    verification_errors?: string[];
}

/** The port's view of an API custom hostname. */
const toCustomHostname = (result: CustomHostnameResult, fallbackHostname: string): CustomHostname => {
    if (!result.id) {
        throw new Error("cloudflare custom hostname answer carried no id");
    }

    return {
        errors: [
            ...(result.verification_errors ?? []),
            ...(result.ssl?.validation_errors ?? []).flatMap((error) => (error.message === undefined ? [] : [error.message])),
        ],
        hostname: result.hostname ?? fallbackHostname,
        id: result.id,
        sslStatus: result.ssl?.status ?? "initializing",
        status: result.status ?? "pending",
    };
};

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

    /** A call that answers `null` on 404 rather than throwing — for reads and deletes of something that may be gone. */
    const callOrMissing = async (fullUrl: string, method: string): Promise<unknown> => {
        const response = await fetchImpl(fullUrl, { headers: { authorization: authHeader, "content-type": "application/json" }, method });

        if (response.status === 404) {
            return null;
        }

        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope;

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare ${method} ${fullUrl} failed: ${message}`);
        }

        return envelope.result ?? {};
    };

    const callAt = async (fullUrl: string, method: string, body?: unknown): Promise<unknown> => {
        const response = await fetchImpl(fullUrl, {
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

    /** A GET whose envelope carries `result_info`, for paginated listings. */
    const getPage = async (fullUrl: string): Promise<{ result: unknown; totalPages: number }> => {
        const response = await fetchImpl(fullUrl, { headers: { authorization: authHeader, "content-type": "application/json" }, method: "GET" });
        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope & { result_info?: { total_pages?: number } };

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare GET ${fullUrl} failed: ${message}`);
        }

        return { result: envelope.result, totalPages: envelope.result_info?.total_pages ?? 1 };
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
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/custom_hostnames`, "POST", {
                hostname,
                ssl: { method: "http", type: "dv" },
            })) as CustomHostnameResult;

            return toCustomHostname(result, hostname);
        },
        deleteCustomHostname: async ({ id, zoneId }) =>
            (await callOrMissing(`${apiRoot}/zones/${zoneId}/custom_hostnames/${encodeURIComponent(id)}`, "DELETE")) !== null,
        createDnsRecord: async ({ content, name, type, zoneId }) => {
            // DNS-only: a box terminates its own TLS (Caddy), so the record must
            // resolve to the box, not to a Cloudflare proxy in front of it.
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/dns_records`, "POST", { content, name, proxied: false, ttl: 300, type })) as {
                id?: string;
            };

            if (!result.id) {
                throw new Error("cloudflare DNS record create returned no id");
            }

            return { id: result.id };
        },
        deleteDnsRecord: async ({ id, zoneId }) => {
            await callAt(`${apiRoot}/zones/${zoneId}/dns_records/${encodeURIComponent(id)}`, "DELETE");
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
        findCustomHostname: async ({ hostname, zoneId }) => {
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`, "GET")) as
                CustomHostnameResult[] | undefined;
            const match = (result ?? []).find((candidate) => candidate.hostname?.toLowerCase() === hostname.toLowerCase());

            return match === undefined ? null : toCustomHostname(match, hostname);
        },
        getCustomHostname: async ({ id, zoneId }) => {
            const result = (await callOrMissing(`${apiRoot}/zones/${zoneId}/custom_hostnames/${encodeURIComponent(id)}`, "GET")) as CustomHostnameResult | null;

            return result === null ? null : toCustomHostname(result, "");
        },
        listDnsRecords: async ({ name, zoneId }) => {
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`, "GET")) as DnsRecord[];

            return result.map((record) => {
                return { content: record.content, id: record.id, name: record.name, type: record.type };
            });
        },
        listDnsRecordsUnder: async ({ domain, zoneId }) => {
            const records: DnsRecord[] = [];

            for (let page = 1; page <= MAX_DNS_LIST_PAGES; page += 1) {
                // eslint-disable-next-line no-await-in-loop -- pagination is sequential by construction
                const { result, totalPages } = await getPage(
                    `${apiRoot}/zones/${zoneId}/dns_records?name.endswith=${encodeURIComponent(`.${domain}`)}&per_page=${String(DNS_PAGE_SIZE)}&page=${String(page)}`,
                );

                for (const record of result as DnsRecord[]) {
                    records.push({ content: record.content, id: record.id, name: record.name, type: record.type });
                }

                if (page >= totalPages) {
                    return { records, truncated: false };
                }
            }

            return { records, truncated: true };
        },
    };
};
