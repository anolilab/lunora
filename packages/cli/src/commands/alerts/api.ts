/**
 * Every Cloudflare call `lunora alerts` makes: the account-scoped REST API
 * (Notifications) and the GraphQL Analytics API. One module so the timeout,
 * the injectable `fetch` and the error classification are decided once.
 *
 * Errors are classified by HTTP status only — Cloudflare's numeric error codes
 * for these endpoints are not documented, so the messages it sends are passed
 * through verbatim rather than interpreted.
 */
import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import { EXIT_CODE } from "../../util/exit-code";

/** How long one Cloudflare call may take. */
const DEFAULT_TIMEOUT_MS = 15_000;

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** The token permission each API needs, named as the dashboard's token editor names it. */
const PERMISSION = {
    analytics: "Account Analytics Read",
    notifications: "Notifications Write",
} as const;

type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

type ApiErrorKind = "auth" | "failure" | "not-found" | "permission" | "rate-limited" | "rejected" | "unavailable";

/** The exit code each error kind maps to. */
const EXIT_CODE_BY_KIND: Record<ApiErrorKind, number> = {
    auth: EXIT_CODE.AUTH,
    failure: EXIT_CODE.FAILURE,
    "not-found": EXIT_CODE.NOT_FOUND,
    permission: EXIT_CODE.PERMISSION,
    "rate-limited": EXIT_CODE.RATE_LIMITED,
    rejected: EXIT_CODE.USAGE,
    unavailable: EXIT_CODE.UNAVAILABLE,
};

class CloudflareApiError extends Error {
    public readonly kind: ApiErrorKind;

    public readonly status: number | undefined;

    public constructor(message: string, kind: ApiErrorKind, status?: number) {
        super(message);
        this.name = "CloudflareApiError";
        this.kind = kind;
        this.status = status;
    }
}

const kindForStatus = (status: number): ApiErrorKind => {
    if (status === 401) {
        return "auth";
    }

    if (status === 403) {
        return "permission";
    }

    if (status === 404) {
        return "not-found";
    }

    if (status === 429) {
        return "rate-limited";
    }

    if (status >= 500) {
        return "unavailable";
    }

    // A 4xx, or a 200 whose envelope says `success: false`: Cloudflare refused the request as sent.
    return "rejected";
};

/** The `errors[].message` strings of a v4 envelope (REST or GraphQL), or the raw text when it is not one. */
const errorMessages = (text: string): string[] => {
    try {
        const body = JSON.parse(text) as { errors?: unknown };

        if (Array.isArray(body.errors)) {
            const messages = body.errors
                .map((entry: unknown) => (typeof entry === "object" && entry !== null && "message" in entry ? String(entry.message) : undefined))
                .filter((message): message is string => message !== undefined && message.length > 0);

            if (messages.length > 0) {
                return messages;
            }
        }
    } catch {
        // Not JSON — a gateway page; fall through to the trimmed text.
    }

    const trimmed = text.trim().slice(0, 200);

    return trimmed.length > 0 ? [trimmed] : [];
};

/**
 * The v4 error code Cloudflare answers a malformed API token with — HTTP 400,
 * "Authentication failed (status: 400)", observed against the live API. A
 * well-formed but wrong token is a plain 401 (code 10000), which the status covers.
 */
const MALFORMED_TOKEN_CODE = 9106;

/** Whether a v4 envelope carries `code` among its errors. */
const hasErrorCode = (text: string, code: number): boolean => {
    try {
        const body = JSON.parse(text) as { errors?: unknown };

        return (
            Array.isArray(body.errors) &&
            body.errors.some((entry: unknown) => typeof entry === "object" && entry !== null && "code" in entry && entry.code === code)
        );
    } catch {
        return false;
    }
};

/** The error a failed call becomes, naming the permission the token needs when that is the likely cause. */
const failure = (what: string, status: number, text: string, permission: Permission): CloudflareApiError => {
    const kind = status === 400 && hasErrorCode(text, MALFORMED_TOKEN_CODE) ? "auth" : kindForStatus(status);
    const reason = errorMessages(text).join("; ");
    let hint = "";

    if (kind === "auth") {
        hint = ` — check that CLOUDFLARE_API_TOKEN is a valid token; it needs the "${permission}" permission on this account`;
    } else if (kind === "permission") {
        hint = ` — the API token needs the "${permission}" permission on this account`;
    }

    return new CloudflareApiError(`${what} failed (HTTP ${String(status)})${reason.length > 0 ? `: ${reason}` : ""}${hint}.`, kind, status);
};

/** A timeout or network failure, as an `unavailable` error. */
const transportFailure = (what: string, error: unknown): CloudflareApiError => {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    let reason = error instanceof Error ? error.message : String(error);

    if (timedOut) {
        reason = "no answer in time";
    }

    return new CloudflareApiError(`${what} failed: ${reason}.`, "unavailable");
};

interface CloudflareClientOptions {
    accountId: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    token: string;
}

interface GraphqlOutcome {
    data: unknown;
    /** GraphQL answers field and authorization errors with HTTP 200 and an `errors` array. */
    errors: string[];
}

interface CloudflareClient {
    accountId: string;
    /** POST a GraphQL Analytics query. Throws only on transport or HTTP failure. */
    graphql: (what: string, query: string, variables?: Record<string, unknown>) => Promise<GraphqlOutcome>;
    /** One Notifications REST call; resolves to the envelope's `result`. */
    notifications: (what: string, method: "DELETE" | "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<unknown>;
}

const createCloudflareClient = (options: CloudflareClientOptions): CloudflareClient => {
    const { accountId, token } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

    return {
        accountId,
        graphql: async (what, query, variables = {}) => {
            let response: Response;

            try {
                response = await fetchImpl(GRAPHQL_URL, {
                    body: JSON.stringify({ query, variables }),
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    method: "POST",
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                throw transportFailure(what, error);
            }

            const text = await response.text();

            if (!response.ok) {
                throw failure(what, response.status, text, PERMISSION.analytics);
            }

            try {
                const body = JSON.parse(text) as { data?: unknown; errors?: unknown };

                return { data: body.data ?? undefined, errors: Array.isArray(body.errors) && body.errors.length > 0 ? errorMessages(text) : [] };
            } catch {
                throw new CloudflareApiError(`${what} failed: the GraphQL API answered with something that is not JSON.`, "unavailable", response.status);
            }
        },
        notifications: async (what, method, path, body) => {
            let outcome: Awaited<ReturnType<typeof cloudflareRestRequest>>;

            try {
                outcome = await cloudflareRestRequest({
                    accountId,
                    apiToken: token,
                    fetch: fetchImpl,
                    init: { method, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
                    path,
                });
            } catch (error) {
                throw transportFailure(what, error);
            }

            if (!outcome.ok) {
                throw failure(what, outcome.status, outcome.text, PERMISSION.notifications);
            }

            return outcome.body["result"];
        },
    };
};

export type { ApiErrorKind, CloudflareClient, CloudflareClientOptions, GraphqlOutcome };
export { CloudflareApiError, createCloudflareClient, EXIT_CODE_BY_KIND, PERMISSION };
