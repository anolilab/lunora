/**
 * Cloudflare's Notifications API (`/accounts/{id}/alerting/v3/*`) for a
 * customer's connected account: the alert types it offers, the notification
 * policies it holds, and creating or replacing one. Used to set up Cloudflare's
 * own Usage Based Billing alerts on a `cloudflare-workers` account, which keep
 * firing even when Lunora Cloud is down.
 *
 * Its own caller rather than `cloudflareFetch`: classifying a failure needs the
 * HTTP status and Cloudflare's error codes, which that caller folds into a
 * message, and every call here is bounded by a timeout. Like it, the token
 * travels only in the `authorization` header and no message echoes it.
 */
import stripTrailingSlashes from "../lib/strip-trailing-slashes";
import { CLOUDFLARE_API_ROOT } from "./fetch";

/** The alert type of a Usage Based Billing notification. */
export const BILLING_USAGE_ALERT = "billing_usage_alert";

/** Deadline for one Notifications API call. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Why a call failed, for whoever has to act on it:
 * - `missing-scope` — the token lacks the Notifications permission (401/403);
 * - `not-eligible` — the account cannot have this alert (Usage Based Billing
 *   notifications are for Pay-as-you-go accounts; most Enterprise contracts are not);
 * - `validation` — Cloudflare rejected the request body (4xx);
 * - `transient` — a timeout, a network failure, 429 or 5xx: try again.
 */
export type NotificationsFailure = "missing-scope" | "not-eligible" | "transient" | "validation";

/** A failed Notifications call. The message is Cloudflare's own text and safe to show the account's owner. */
export class CloudflareNotificationsError extends Error {
    public readonly codes: number[];

    public readonly kind: NotificationsFailure;

    public readonly status: number | null;

    public constructor(kind: NotificationsFailure, message: string, status: number | null, codes: number[] = []) {
        super(message);
        this.name = "CloudflareNotificationsError";
        this.kind = kind;
        this.status = status;
        this.codes = codes;
    }
}

/**
 * Wording that marks a refusal as the account's plan rather than the token or
 * the body. Cloudflare documents no error code for it, so this reads its text;
 * a refusal this misses is still reported with Cloudflare's message, as a
 * missing scope or a validation error.
 */
const NOT_ELIGIBLE =
    /\b(?:not eligible|ineligible|not entitled|entitlement|pay[\s-]as[\s-]you[\s-]go|upgrade your plan|not available (?:for|on) (?:this|your) (?:account|plan))\b/iu;

interface Envelope {
    errors?: { code?: number; message?: string }[];
    result?: unknown;
    result_info?: { page?: number; total_pages?: number };
    success?: boolean;
}

/** Classify a non-2xx (or `success: false`) answer. */
export const classifyFailure = (status: number, message: string): NotificationsFailure => {
    if (NOT_ELIGIBLE.test(message)) {
        return "not-eligible";
    }

    if (status === 401 || status === 403) {
        return "missing-scope";
    }

    if (status === 429 || status >= 500) {
        return "transient";
    }

    return "validation";
};

/** One discoverable product of a Usage Based Billing notification: the `filters.product` value and Cloudflare's name for it. */
export interface BillingProduct {
    description: string;
    id: string;
}

/** A notification policy, as much of it as this flow reads. */
export interface NotificationPolicy {
    /** How often Cloudflare re-alerts, when the policy sets it. */
    alertInterval?: string;
    alertType: string;
    enabled: boolean;
    filters: Record<string, string[]>;
    id: string;
    /** Where it notifies, by kind (`email`, `webhooks`, `pagerduty`); an email entry's `id` is the address. */
    mechanisms: Record<string, { id: string }[]>;
    name: string;
}

/** The body of a policy this flow writes. */
export interface PolicyBody {
    alert_interval?: string;
    alert_type: string;
    description?: string;
    enabled: boolean;
    filters?: Record<string, string[]>;
    mechanisms: Record<string, { id: string }[]>;
    name: string;
}

/** What the client authenticates with. */
export interface NotificationsAccess {
    accountId: string;
    apiToken: string;
    /** Override for tests; defaults to the public v4 root. */
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
}

/** The Notifications API of one account. */
export interface NotificationsClient {
    /** `GET available_alerts`: the products a Usage Based Billing notification may filter on, or `null` when the account is not offered that alert at all. */
    billingProducts: () => Promise<BillingProduct[] | null>;
    createPolicy: (body: PolicyBody) => Promise<string>;
    deletePolicy: (id: string) => Promise<void>;

    /**
     * Every policy on the account. One call: the API takes no paging parameter
     * and answers no `result_info` (Cloudflare's OpenAPI schema), so the
     * listing is complete as answered; `result_info.total_pages` above 1 would
     * contradict that and is refused rather than read as complete.
     */
    listPolicies: () => Promise<NotificationPolicy[]>;
    updatePolicy: (id: string, body: PolicyBody) => Promise<void>;
}

interface AvailableAlert {
    filter_options?: unknown;
    type?: unknown;
}

interface FilterOption {
    AvailableValues?: unknown;
    Key?: unknown;
}

/** One alert type's `product` filter values, as `[id, description]` pairs. */
const productValuesOf = (alert: AvailableAlert): [string, string][] => {
    const options = Array.isArray(alert.filter_options) ? (alert.filter_options as FilterOption[]) : [];
    const values = options
        .filter((option) => typeof option.Key === "string" && option.Key.toLowerCase() === "product" && Array.isArray(option.AvailableValues))
        .flatMap((option) => option.AvailableValues as { Description?: unknown; ID?: unknown }[]);

    return values
        .filter((value): value is { Description?: unknown; ID: string } => typeof value.ID === "string" && value.ID !== "")
        .map((value) => [value.ID, typeof value.Description === "string" && value.Description !== "" ? value.Description : value.ID]);
};

/**
 * The `product` values of the `billing_usage_alert` entries in an
 * `available_alerts` result, as its `filter_options` list them
 * (`{ Key, AvailableValues: [{ ID, Description }] }`). `null` when no
 * category offers the alert type; an empty list when it is offered but names
 * no product values.
 */
export const billingProductsOf = (result: unknown): BillingProduct[] | null => {
    if (typeof result !== "object" || result === null) {
        return null;
    }

    const alerts = Object.values(result as Record<string, unknown>)
        .filter((entries): entries is AvailableAlert[] => Array.isArray(entries))
        .flat()
        .filter((alert) => alert.type === BILLING_USAGE_ALERT);

    if (alerts.length === 0) {
        return null;
    }

    return [...new Map(alerts.flatMap((alert) => productValuesOf(alert)))].map(([id, description]) => {
        return { description, id };
    });
};

const toPolicy = (raw: Record<string, unknown>): NotificationPolicy | null => {
    if (typeof raw["id"] !== "string" || typeof raw["name"] !== "string") {
        return null;
    }

    const filters: Record<string, string[]> = {};

    for (const [key, value] of Object.entries((raw["filters"] ?? {}) as Record<string, unknown>)) {
        if (Array.isArray(value)) {
            filters[key] = value.filter((item): item is string => typeof item === "string");
        }
    }

    const mechanisms: Record<string, { id: string }[]> = {};

    for (const [kind, value] of Object.entries((raw["mechanisms"] ?? {}) as Record<string, unknown>)) {
        if (Array.isArray(value)) {
            mechanisms[kind] = (value as { id?: unknown }[])
                .filter((entry): entry is { id: string } => typeof entry.id === "string" && entry.id !== "")
                .map((entry) => {
                    return { id: entry.id };
                });
        }
    }

    return {
        alertType: typeof raw["alert_type"] === "string" ? raw["alert_type"] : "",
        ...(typeof raw["alert_interval"] === "string" ? { alertInterval: raw["alert_interval"] } : {}),
        enabled: raw["enabled"] !== false,
        filters,
        id: raw["id"],
        mechanisms,
        name: raw["name"],
    };
};

/** The error a failed answer stands for, with Cloudflare's own text. */
const failureOf = (status: number, envelope: Envelope | null, what: string): CloudflareNotificationsError => {
    const errors = envelope?.errors ?? [];
    const text = errors
        .map((error) => error.message)
        .filter((message): message is string => typeof message === "string" && message !== "")
        .join("; ")
        .slice(0, 300);
    const message = text === "" ? `HTTP ${String(status)}` : text;
    const codes = errors.map((error) => error.code).filter((code): code is number => typeof code === "number");

    return new CloudflareNotificationsError(classifyFailure(status, message), `Cloudflare ${what} failed: ${message}`, status, codes);
};

/** One bounded call; a network failure or a timeout is transient. */
const send = async (fetchImpl: typeof globalThis.fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out" : "could not be reached";

        throw new CloudflareNotificationsError("transient", `Cloudflare's Notifications API ${reason}`, null);
    }
};

/** Bind the Notifications API to one account's token. Every call throws {@link CloudflareNotificationsError} on failure. */
export const notificationsClient = (access: NotificationsAccess): NotificationsClient => {
    const root = `${stripTrailingSlashes(access.baseUrl ?? CLOUDFLARE_API_ROOT)}/accounts/${access.accountId}/alerting/v3`;
    const fetchImpl = access.fetch ?? globalThis.fetch;
    const timeoutMs = access.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const call = async (method: "DELETE" | "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Envelope> => {
        const init = {
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: { authorization: `Bearer ${access.apiToken}`, "content-type": "application/json" },
            method,
        };
        const response = await send(fetchImpl, `${root}${path}`, init, timeoutMs);
        const envelope = (await response.json().catch(() => null)) as Envelope | null;

        if (response.ok && envelope?.success !== false) {
            return envelope ?? {};
        }

        throw failureOf(response.status, envelope, `${method} alerting/v3${path.split("?")[0] ?? path}`);
    };

    return {
        billingProducts: async () => {
            const { result } = await call("GET", "/available_alerts");

            return billingProductsOf(result);
        },
        createPolicy: async (body) => {
            const { result } = await call("POST", "/policies", body);
            const id = (result as { id?: unknown } | undefined)?.id;

            if (typeof id !== "string") {
                throw new CloudflareNotificationsError("transient", "Cloudflare created the policy but answered no id", null);
            }

            return id;
        },
        deletePolicy: async (id) => {
            await call("DELETE", `/policies/${encodeURIComponent(id)}`);
        },
        listPolicies: async () => {
            const envelope = await call("GET", "/policies");

            if ((envelope.result_info?.total_pages ?? 1) > 1) {
                throw new CloudflareNotificationsError(
                    "transient",
                    "Cloudflare answered the policy list in pages, which this client does not read; refusing to treat it as complete",
                    null,
                );
            }

            const rows = Array.isArray(envelope.result) ? (envelope.result as Record<string, unknown>[]) : [];

            return rows.map((row) => toPolicy(row)).filter((policy): policy is NotificationPolicy => policy !== null);
        },
        updatePolicy: async (id, body) => {
            await call("PUT", `/policies/${encodeURIComponent(id)}`, body);
        },
    };
};
