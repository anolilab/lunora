/**
 * The one Cloudflare v4 REST caller: a bearer token, the `{ success, errors,
 * result }` envelope, and the failure taxonomy every Cloudflare reader of the
 * control plane shares — the platform's own account (`src/cloudflare/api.ts`),
 * a customer's connected account (`src/targets/cloudflare-workers/api.ts`) and
 * its billable usage (`src/cloudflare/billable-usage.ts`).
 *
 * The token travels only in the `authorization` header. Every error message is
 * built from the method, the path without its query, and Cloudflare's own error
 * text — none of which echoes the token — so a message is safe to log and, for
 * a {@link CloudflareTokenError}, to show the organization that pasted it.
 */
import stripTrailingSlashes from "../lib/strip-trailing-slashes";

/** The public v4 API root. */
export const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4";

/** The token was refused (401/403), or is not active. The message is safe to show whoever supplied the token. */
export class CloudflareTokenError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CloudflareTokenError";
    }
}

/** What one caller authenticates with. */
export interface CloudflareCredentials {
    apiToken: string;
    /** Override for tests; defaults to {@link CLOUDFLARE_API_ROOT}. */
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
}

/** {@link CloudflareCredentials} for one account — what account-scoped readers take. */
export interface CloudflareAccountAccess extends CloudflareCredentials {
    accountId: string;
}

/** One call. */
export interface CloudflareRequest {
    /** Answer `null` for a 404 instead of throwing — for reads and deletes of something that may be gone. */
    allow404?: boolean;
    /** JSON-encoded as the request body. */
    body?: unknown;
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
}

/** A successful envelope's payload. `result` is absent where an endpoint answers none. */
export interface CloudflareAnswer<T> {
    result: T | undefined;
    /** `result_info.total_pages` of a paginated listing; 1 when the envelope carries none. */
    totalPages: number;
}

interface Envelope {
    errors?: { code?: number; message?: string }[];
    result?: unknown;
    result_info?: { total_pages?: number };
    success?: boolean;
}

/** Cloudflare's own error text, bounded, or the status when it gave none. */
const describeErrors = (envelope: Envelope | null, status: number): string => {
    const messages = (envelope?.errors ?? []).map((error) => error.message).filter((message): message is string => typeof message === "string");

    return messages.length > 0 ? messages.join("; ").slice(0, 300) : `HTTP ${String(status)}`;
};

/** A path as error messages name it: without its query, which may carry a hostname or a filter. */
const pathOnly = (path: string): string => path.split("?")[0] ?? path;

/** A v4 caller bound to one token. */
export type CloudflareFetch = <T>(path: string, request?: CloudflareRequest) => Promise<CloudflareAnswer<T> | null>;

/**
 * Bind a v4 caller to `credentials`. A call answers the envelope's payload, or
 * `null` for a 404 when the request allows one; a refused token (401/403)
 * throws {@link CloudflareTokenError}, and any other failure (a non-2xx, or
 * `success: false`) a plain `Error`.
 */
export const cloudflareFetch = (credentials: CloudflareCredentials): CloudflareFetch => {
    const root = stripTrailingSlashes(credentials.baseUrl ?? CLOUDFLARE_API_ROOT);
    const fetchImpl = credentials.fetch ?? globalThis.fetch;

    return async <T>(path: string, request: CloudflareRequest = {}): Promise<CloudflareAnswer<T> | null> => {
        const method = request.method ?? "GET";
        const response = await fetchImpl(`${root}${path}`, {
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            headers: { authorization: `Bearer ${credentials.apiToken}`, "content-type": "application/json" },
            method,
        });

        if (response.status === 404 && request.allow404 === true) {
            return null;
        }

        const envelope = (await response.json().catch(() => null)) as Envelope | null;

        if (response.status === 401 || response.status === 403) {
            throw new CloudflareTokenError(`Cloudflare refused the token for ${method} ${pathOnly(path)}: ${describeErrors(envelope, response.status)}`);
        }

        if (!response.ok || envelope?.success === false) {
            throw new Error(`Cloudflare ${method} ${pathOnly(path)} failed: ${describeErrors(envelope, response.status)}`);
        }

        return { result: envelope?.result as T | undefined, totalPages: envelope?.result_info?.total_pages ?? 1 };
    };
};
