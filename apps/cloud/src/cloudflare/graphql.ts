/**
 * The one caller of Cloudflare's GraphQL Analytics API (`POST /graphql`). It is
 * shared by every account the control plane reads analytics from: the
 * platform's own cell account (`cloudflare-wfp`) and each connected customer
 * account (`cloudflare-workers`).
 *
 * The token travels only in the `authorization` header. Errors are built from
 * the status and Cloudflare's own error text, which never echoes the token.
 */
import type { CloudflareAccountAccess } from "./fetch";
import { CLOUDFLARE_API_ROOT, CloudflareTokenError } from "./fetch";

/**
 * Cloudflare answered, and rejected the query itself: a 200 whose `errors` name
 * a field, an argument or a dataset it does not accept, or introspection it
 * does not allow. Asking again next hour gets the same answer, so the usage
 * readback shows it as the source being unavailable (`unavailableOnRefusal`)
 * rather than logging a failure every hour. The message is Cloudflare's text.
 */
export class CloudflareGraphqlQueryError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CloudflareGraphqlQueryError";
    }
}

/** How the GraphQL API words a token that lacks the permission for a query. */
const AUTHORIZATION_ERROR = /\bauthoriz|permission|not allowed/iu;

interface GraphqlResponse<T> {
    data?: null | T;
    errors?: { message?: string }[] | null;
}

/**
 * Run one GraphQL query against the account's analytics and answer its `data`.
 * @throws {CloudflareTokenError} when the token is refused, or lacks Account Analytics Read.
 * @throws {CloudflareGraphqlQueryError} when Cloudflare answers and rejects the query itself.
 * @throws {Error} on any other failure (a non-2xx, or no `data`), with Cloudflare's error text.
 */
export const cloudflareGraphql = async <T>(access: CloudflareAccountAccess, query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const root = access.baseUrl ?? CLOUDFLARE_API_ROOT;
    const response = await (access.fetch ?? globalThis.fetch)(`${root}/graphql`, {
        body: JSON.stringify({ query, variables }),
        headers: { authorization: `Bearer ${access.apiToken}`, "content-type": "application/json" },
        method: "POST",
    });
    const body = (await response.json().catch(() => null)) as GraphqlResponse<T> | null;

    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError("Cloudflare refused the token for the GraphQL Analytics API");
    }

    const errors = (body?.errors ?? []).map((error) => error.message ?? "").filter((message) => message !== "");

    if (!response.ok || errors.length > 0 || !body?.data) {
        const reason = errors.length > 0 ? errors.join("; ").slice(0, 300) : `HTTP ${String(response.status)}`;

        // GraphQL answers a missing permission as a 200 with an authorization error.
        if (AUTHORIZATION_ERROR.test(reason)) {
            throw new CloudflareTokenError(`Cloudflare refused the token for the GraphQL Analytics API: ${reason}`);
        }

        // A 200 that names what it rejects will reject it again; anything else may pass on a retry.
        if (response.ok && errors.length > 0) {
            throw new CloudflareGraphqlQueryError(`Cloudflare GraphQL Analytics API rejected the query: ${reason}`);
        }

        throw new Error(`Cloudflare GraphQL Analytics API failed: ${reason}`);
    }

    return body.data;
};

/** An ISO-8601 instant as the GraphQL `Time` filters take it. */
export const graphqlTime = (ms: number): string => new Date(ms).toISOString();
