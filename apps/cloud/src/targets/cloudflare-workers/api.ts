/**
 * The `cloudflare-workers` target's REST and GraphQL reads against a
 * customer's OWN Cloudflare account, with the scoped API token the
 * organization connected (`lunora/cloudflare-accounts.ts`). Workerd-safe: plain
 * `fetch`, injectable, so every call is unit-tested with a fake.
 *
 * Read-only by construction. Converging resources and uploading the Worker is
 * the provision box's job (Alchemy 2, `src/targets/provision-box/`); this
 * module only checks a token when it is connected, finds the account's
 * `workers.dev` subdomain, and reads request counts back for metering.
 *
 * The token never appears in an error message or a log line: every failure is
 * reported by status and Cloudflare's own error text, which never echoes it.
 */

const API_ROOT = "https://api.cloudflare.com/client/v4";

/** A Cloudflare account id: 32 lowercase hex characters. */
const ACCOUNT_ID = /^[\da-f]{32}$/u;

export const isCloudflareAccountId = (value: unknown): value is string => typeof value === "string" && ACCOUNT_ID.test(value);

/** How every call reaches one account. */
export interface CloudflareAccountAccess {
    accountId: string;
    apiToken: string;
    fetch?: typeof globalThis.fetch;
}

/** The token was refused (401/403), or is not active. The message is safe to show the organization that pasted it. */
export class CloudflareTokenError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CloudflareTokenError";
    }
}

interface Envelope<T> {
    errors?: { code?: number; message?: string }[];
    result?: T;
    success?: boolean;
}

const describeErrors = (envelope: Envelope<unknown> | null, status: number): string => {
    const messages = (envelope?.errors ?? []).map((error) => error.message).filter((message): message is string => typeof message === "string");

    return messages.length > 0 ? messages.join("; ").slice(0, 300) : `HTTP ${String(status)}`;
};

/** GET (or POST) one v4 endpoint; a refused token throws {@link CloudflareTokenError}, any other failure a plain Error. */
const call = async <T>(access: CloudflareAccountAccess, path: string, init: RequestInit = {}): Promise<T> => {
    const response = await (access.fetch ?? globalThis.fetch)(`${API_ROOT}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${access.apiToken}`, "content-type": "application/json" },
    });
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;

    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError(`Cloudflare refused the token for ${path.split("?")[0] ?? path}: ${describeErrors(envelope, response.status)}`);
    }

    if (!response.ok || envelope?.success === false || envelope?.result === undefined) {
        throw new Error(`Cloudflare API ${path.split("?")[0] ?? path} failed: ${describeErrors(envelope, response.status)}`);
    }

    return envelope.result;
};

/** What `tokens/verify` reports about a token. */
export interface VerifiedToken {
    expiresAt?: number;
    id?: string;
}

interface VerifyResult {
    expires_on?: string;
    id?: string;
    status?: string;
}

/**
 * Verify the token is valid and active. A user-owned token answers
 * `GET /user/tokens/verify`; an account-owned one only
 * `GET /accounts/{id}/tokens/verify`, so the second is tried when the first refuses.
 * @throws {CloudflareTokenError} when neither accepts it, or it is not `active`.
 */
export const verifyToken = async (access: CloudflareAccountAccess): Promise<VerifiedToken> => {
    let result: VerifyResult;

    try {
        result = await call<VerifyResult>(access, "/user/tokens/verify");
    } catch {
        result = await call<VerifyResult>(access, `/accounts/${access.accountId}/tokens/verify`);
    }

    if (result.status !== "active") {
        throw new CloudflareTokenError(`the token is ${result.status ?? "not active"}`);
    }

    const expiresAt = result.expires_on === undefined ? Number.NaN : Date.parse(result.expires_on);

    return { ...(Number.isFinite(expiresAt) ? { expiresAt } : {}), ...(result.id === undefined ? {} : { id: result.id }) };
};

/**
 * The account's `workers.dev` subdomain (`GET /accounts/{id}/workers/subdomain`,
 * Workers Scripts Read or Edit). A tenant Worker answers at
 * `https://{script}.{subdomain}.workers.dev`.
 * @throws {Error} when the account has none registered — it must claim one in the dashboard first.
 */
export const readWorkersSubdomain = async (access: CloudflareAccountAccess): Promise<string> => {
    const result = await call<{ subdomain?: string }>(access, `/accounts/${access.accountId}/workers/subdomain`);

    if (typeof result.subdomain !== "string" || result.subdomain === "") {
        throw new Error("this Cloudflare account has no workers.dev subdomain yet; open Workers & Pages in its dashboard once to claim one");
    }

    return result.subdomain;
};

/**
 * The account's display name, best-effort: `GET /accounts/{id}` needs Account
 * Settings Read, which the target does not otherwise need, so a token without
 * it is fine and answers `null`.
 */
export const readDisplayName = async (access: CloudflareAccountAccess): Promise<null | string> => {
    try {
        const result = await call<{ name?: string }>(access, `/accounts/${access.accountId}`);

        return typeof result.name === "string" ? result.name.slice(0, 128) : null;
    } catch {
        return null;
    }
};

/** One token permission the target uses, with how it is detected. */
export interface PermissionProbe {
    /** The permission's name in Cloudflare's token editor. */
    label: string;
    /** A read-only GET that answers 2xx only when the token holds the permission group (read or edit). */
    path: (accountId: string) => string;
    /** Whether a connection is refused without it. */
    required: boolean;
    /** What the target uses it for. */
    use: string;
}

/**
 * The permissions the `cloudflare-workers` target needs, least-privilege. Edit
 * on each because the provision box creates the resources; the probes below
 * are read-only, so what is recorded at connect time is "this permission group
 * is granted", not "this permission is Edit" — Cloudflare's API does not
 * expose a token's own policies without the API Tokens Read permission, which
 * the target deliberately does not ask for. A token granted Read where Edit is
 * needed fails its first converge, with Cloudflare's own error.
 */
export const PERMISSION_PROBES = {
    analytics: {
        label: "Account Analytics: Read",
        path: () => "/graphql",
        required: false,
        use: "request counts for the usage chart",
    },
    d1: { label: "D1: Edit", path: (id) => `/accounts/${id}/d1/database?per_page=1`, required: false, use: "d1 bindings" },
    kv: { label: "Workers KV Storage: Edit", path: (id) => `/accounts/${id}/storage/kv/namespaces?per_page=1`, required: false, use: "kv bindings" },
    queues: { label: "Queues: Edit", path: (id) => `/accounts/${id}/queues?per_page=1`, required: false, use: "queue bindings" },
    r2: { label: "Workers R2 Storage: Edit", path: (id) => `/accounts/${id}/r2/buckets?per_page=1`, required: false, use: "r2 bindings" },
    workersScripts: {
        label: "Workers Scripts: Edit",
        path: (id) => `/accounts/${id}/workers/scripts`,
        required: true,
        use: "uploading the Worker, its cron triggers and queue consumers, and reading the workers.dev subdomain",
    },
} as const satisfies Record<string, PermissionProbe>;

export type CloudflarePermission = keyof typeof PERMISSION_PROBES;

export const CLOUDFLARE_PERMISSIONS = Object.keys(PERMISSION_PROBES) as CloudflarePermission[];

/** One script's requests in a window. */
export interface ScriptRequests {
    requests: number;
    scriptName: string;
}

interface GraphqlResponse {
    data?: {
        viewer?: {
            accounts?: { workersInvocationsAdaptive?: { dimensions?: { scriptName?: string }; sum?: { requests?: number } }[] }[];
        };
    } | null;
    errors?: { message?: string }[] | null;
}

/** How the GraphQL API words a token that lacks the permission for a query. */
const AUTHORIZATION_ERROR = /\bauthoriz|permission|not allowed/iu;

/** Row cap of one readback: one row per script, so this is the number of Workers an account may run before a window under-counts. */
const MAX_SCRIPTS = 10_000;

const REQUESTS_QUERY = `query LunoraWorkerRequests($accountTag: string!, $since: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: ${String(MAX_SCRIPTS)}, filter: { datetime_gt: $since }) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`;

/**
 * Requests per Worker script in the account with an invocation time strictly
 * after `sinceMs` — the GraphQL Analytics API's `workersInvocationsAdaptive`
 * dataset (Account Analytics Read), summed per `scriptName`. Its `sum` fields
 * are already corrected for Cloudflare's adaptive sampling, so the total is an
 * estimate only where Cloudflare's own dashboard is one.
 * @throws {CloudflareTokenError} when the token lacks Account Analytics Read.
 */
export const readScriptRequests = async (access: CloudflareAccountAccess, sinceMs: number): Promise<ScriptRequests[]> => {
    const response = await (access.fetch ?? globalThis.fetch)(`${API_ROOT}/graphql`, {
        body: JSON.stringify({ query: REQUESTS_QUERY, variables: { accountTag: access.accountId, since: new Date(sinceMs).toISOString() } }),
        headers: { authorization: `Bearer ${access.apiToken}`, "content-type": "application/json" },
        method: "POST",
    });
    const body = (await response.json().catch(() => null)) as GraphqlResponse | null;

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

        throw new Error(`Cloudflare GraphQL Analytics API failed: ${reason}`);
    }

    const totals = new Map<string, number>();

    for (const account of body.data.viewer?.accounts ?? []) {
        for (const row of account.workersInvocationsAdaptive ?? []) {
            const scriptName = row.dimensions?.scriptName;
            const requests = row.sum?.requests ?? 0;

            if (typeof scriptName === "string" && scriptName !== "" && Number.isFinite(requests) && requests > 0) {
                totals.set(scriptName, (totals.get(scriptName) ?? 0) + requests);
            }
        }
    }

    return [...totals].map(([scriptName, requests]) => {
        return { requests, scriptName };
    });
};

/** Probe one permission: `true` when its read answers, `false` when Cloudflare refuses the token for it. */
const probe = async (access: CloudflareAccountAccess, permission: CloudflarePermission): Promise<boolean> => {
    try {
        await (permission === "analytics"
            ? readScriptRequests(access, Date.now() - 60_000)
            : call(access, PERMISSION_PROBES[permission].path(access.accountId)));

        return true;
    } catch {
        return false;
    }
};

/** What connecting a token established about the account. */
export interface AccountInspection {
    displayName: null | string;
    /** The permission groups the token was seen to hold, in {@link CLOUDFLARE_PERMISSIONS} order. */
    permissions: CloudflarePermission[];
    token: VerifiedToken;
    workersSubdomain: string;
}

/**
 * Everything connecting (or rotating) a token checks: the token is active,
 * reaches THIS account, holds every required permission, and the account has
 * a `workers.dev` subdomain to serve tenants on.
 * @throws {CloudflareTokenError} with a message for the person who pasted the token.
 */
export const inspectAccount = async (access: CloudflareAccountAccess): Promise<AccountInspection> => {
    if (!isCloudflareAccountId(access.accountId)) {
        throw new CloudflareTokenError("the account id must be the 32-character hex id from the Cloudflare dashboard");
    }

    const token = await verifyToken(access);
    const granted = await Promise.all(CLOUDFLARE_PERMISSIONS.map(async (permission) => [permission, await probe(access, permission)] as const));
    const permissions = granted.filter(([, ok]) => ok).map(([permission]) => permission);
    const missing = CLOUDFLARE_PERMISSIONS.filter((permission) => PERMISSION_PROBES[permission].required && !permissions.includes(permission));

    if (missing.length > 0) {
        throw new CloudflareTokenError(
            `the token cannot reach this account with ${missing.map((permission) => PERMISSION_PROBES[permission].label).join(", ")}; create it with that permission on this account`,
        );
    }

    let workersSubdomain: string;

    try {
        workersSubdomain = await readWorkersSubdomain(access);
    } catch (error) {
        throw new CloudflareTokenError(error instanceof Error ? error.message : "could not read the account's workers.dev subdomain");
    }

    return { displayName: await readDisplayName(access), permissions, token, workersSubdomain };
};
