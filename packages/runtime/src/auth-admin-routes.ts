import { CirrusError } from "./errors";

/** A timestamp as better-auth stores it: epoch-ms, an ISO string, or absent. */
type AuthTimestamp = null | number | string;

/**
 * One authenticated user, as the auth browser surfaces it. Mirrors better-auth's
 * `user` row plus the `admin()` plugin columns (`role`/`banned`/…); the index
 * signature additionally carries any app-defined `user.additionalFields`.
 */
interface AuthUser {
    [key: string]: unknown;
    banExpires?: AuthTimestamp;
    banned?: boolean | null;
    banReason?: null | string;
    createdAt?: AuthTimestamp;
    email?: null | string;
    emailVerified?: boolean | null;
    id: string;
    image?: null | string;
    name?: null | string;
    role?: null | string;
}

/** One auth session, as the auth browser surfaces it. Mirrors better-auth's `session` row. */
interface AuthSession {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    expiresAt?: AuthTimestamp;
    id: string;
    impersonatedBy?: null | string;
    ipAddress?: null | string;
    userAgent?: null | string;
    userId: string;
}

/** A page of users or sessions plus the total count, for paginated browsing. */
interface AuthPage<T> {
    rows: T[];
    total: number;
}

/** The result of {@link AuthAdmin.impersonateUser}: a session token to act as the target user. */
interface AuthImpersonation {
    expiresAt?: AuthTimestamp;
    token: string;
    user: AuthUser;
}

/**
 * Which admin surfaces the configured auth plane supports, derived from the
 * enabled better-auth plugins. The studio renders only the panels whose
 * capability is `true`.
 */
interface AuthCapabilities {
    accounts: boolean;
    admin: boolean;
    organization: boolean;
    passkey: boolean;
    twoFactor: boolean;
}

/** Filtering / paging options forwarded to {@link AuthAdmin.listUsers} from the users endpoint's query string. */
interface ListAuthUsersOptions {
    filterField?: string;
    filterValue?: string;
    limit?: number;
    offset?: number;
    search?: string;
    searchField?: string;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

/**
 * The auth user-management plane backing the studio's auth dashboard. The host
 * wires this to better-auth (typically via `@cirrus/auth`'s `createAuthAdmin`);
 * the runtime stays free of a hard dependency on `@cirrus/auth`. The read
 * methods back the GET browse endpoints; the optional mutations back the
 * admin-gated POST endpoints — a host that only needs read-only browsing can
 * omit them (the POST routes then respond `AUTH_OP_NOT_SUPPORTED`). Omit the
 * whole option and every `/auth/*` endpoint responds `AUTH_NOT_CONFIGURED`.
 *
 * Every method here runs behind the worker's `CIRRUS_ADMIN_TOKEN` gate — the
 * implementation is a trusted server-side operator, not an end-user API.
 */
interface AuthAdmin {
    banUser?: (input: { expiresInSeconds?: number; reason?: string; userId: string }) => Promise<AuthUser>;
    cancelInvitation?: (input: { invitationId: string }) => Promise<void>;
    capabilities?: () => Promise<AuthCapabilities>;
    createUser?: (input: { data?: Record<string, unknown>; email: string; name: string; password?: string; role?: string | string[] }) => Promise<AuthUser>;
    deletePasskey?: (input: { passkeyId: string }) => Promise<void>;
    disableTwoFactor?: (input: { userId: string }) => Promise<void>;
    impersonateUser?: (input: { userId: string }) => Promise<AuthImpersonation>;
    listAccounts?: (input: { userId: string }) => Promise<Record<string, unknown>[]>;
    listInvitations?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listMembers?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listOrganizations?: (options: { limit?: number; offset?: number }) => Promise<AuthPage<Record<string, unknown>>>;
    listPasskeys?: (input: { userId: string }) => Promise<Record<string, unknown>[]>;
    // `listUsers`/`listSessions` are the only required members: they're the
    // read-only browse surface that even a deprecated `authIntrospector`
    // (`Pick<AuthAdmin, "listUsers" | "listSessions">`) must provide. Every other
    // op is optional and guarded at dispatch (`AUTH_OP_NOT_SUPPORTED`).
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>;
    listUsers: (options: ListAuthUsersOptions) => Promise<AuthPage<AuthUser>>;
    removeMember?: (input: { memberId: string }) => Promise<void>;
    removeUser?: (input: { userId: string }) => Promise<void>;
    revokeUserSession?: (input: { sessionId: string }) => Promise<void>;
    revokeUserSessions?: (input: { userId: string }) => Promise<void>;
    setRole?: (input: { role: string | string[]; userId: string }) => Promise<AuthUser>;
    setUserPassword?: (input: { newPassword: string; userId: string }) => Promise<void>;
    unbanUser?: (input: { userId: string }) => Promise<AuthUser>;
    unlinkAccount?: (input: { accountId: string; userId: string }) => Promise<void>;
    updateUser?: (input: { data: Record<string, unknown>; userId: string }) => Promise<AuthUser>;
}

/**
 * Read-only subset of {@link AuthAdmin}, kept as an alias for the former
 * `authIntrospector` option (which the worker still honours as a browse-only
 * fallback). Prefer wiring `authAdmin` with `@cirrus/auth`'s `createAuthAdmin`
 * so the mutation endpoints light up too.
 */
type AuthIntrospector = Pick<AuthAdmin, "listSessions" | "listUsers">;

/** Closure-scoped worker helpers the auth routes borrow (so this module stays out of the worker's god-closure). */
interface AuthAdminRouteDeps {
    /** Throw 403 unless the request carries a valid admin bearer. */
    assertAdmin: (request: Request) => void;
    /** The configured auth plane (new `authAdmin`, else the deprecated `authIntrospector`), or undefined. */
    getAuthAdmin: () => AuthAdmin | undefined;
    /** Parse the shared `limit`/`offset` paging params off a GET request. */
    parsePaging: (request: Request) => { limit?: number; offset?: number };
    /** Read a query param, collapsing missing/empty to `undefined`. */
    queryParameter: (url: URL, name: string) => string | undefined;
    /** Read + size-limit a JSON request body. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
}

/** Context handed to each descriptor's `build` so it can pull args from the query string or the JSON body. */
interface AuthRouteContext {
    body: Record<string, unknown>;
    paging: { limit?: number; offset?: number };
    query: (name: string) => string | undefined;
}

/** One auth-admin route: which `AuthAdmin` method it drives, how to build that method's input, and how to shape the reply. */
interface AuthRouteDescriptor {
    /** Build the method input from query (GET) or body (POST); throw `CirrusError` for invalid input. */
    build: (context: AuthRouteContext) => unknown;
    http: "GET" | "POST";
    method: keyof AuthAdmin;
    /** `void` mutations reply `{ ok: true }`; otherwise the method's return value is sent verbatim. */
    returns?: "value" | "void";
}

const AUTH_BASE = "/_cirrus/admin/auth";

/** HTTP status for an `authAdmin` error code; everything else falls back to 400. */
const AUTH_ADMIN_ERROR_STATUS: Record<string, number> = {
    PASSWORD_TOO_LONG: 400,
    PASSWORD_TOO_SHORT: 400,
    USER_ALREADY_EXISTS: 409,
    USER_NOT_FOUND: 404,
};

/** Read a required non-empty string field off a parsed body, else 400. */
const requireBodyString = (body: Record<string, unknown>, field: string): string => {
    const value = body[field];

    if (typeof value !== "string" || value === "") {
        throw new CirrusError(`\`${field}\` is required`, { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/** Read a required query param, else 400. */
const requireQuery = (query: (name: string) => string | undefined, name: string): string => {
    const value = query(name);

    if (value === undefined) {
        throw new CirrusError(`\`${name}\` query parameter is required`, { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/** Coerce a `role` body value to better-auth's `string | string[]`, else `undefined`. */
// eslint-disable-next-line sonarjs/function-return-type -- mirrors better-auth's `string | string[]` role shape
const parseRoleInput = (value: unknown): string | string[] | undefined => {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        return value;
    }

    return undefined;
};

const optionalBodyString = (body: Record<string, unknown>, field: string): string | undefined => (typeof body[field] === "string" ? body[field] : undefined);

/**
 * The full auth-admin route table. Each entry is data, not a hand-wired handler —
 * one driver ({@link buildAuthAdminRoutes}) dispatches all of them, so adding an
 * operation is a single row here plus the matching `AuthAdmin` method.
 */
const AUTH_ROUTES: Record<string, AuthRouteDescriptor> = {
    [`${AUTH_BASE}/capabilities`]: {
        build: () => {
            return {};
        },
        http: "GET",
        method: "capabilities",
    },
    [`${AUTH_BASE}/users`]: {
        build: ({ paging, query }) => {
            const direction = query("sortDirection");

            return {
                ...paging,
                filterField: query("filterField"),
                filterValue: query("filterValue"),
                search: query("search"),
                searchField: query("searchField"),
                sortBy: query("sortBy"),
                sortDirection: direction === "asc" || direction === "desc" ? direction : undefined,
            };
        },
        http: "GET",
        method: "listUsers",
    },
    [`${AUTH_BASE}/sessions`]: {
        build: ({ paging, query }) => {
            return { ...paging, userId: query("userId") };
        },
        http: "GET",
        method: "listSessions",
    },
    [`${AUTH_BASE}/accounts`]: {
        build: ({ query }) => {
            return { userId: requireQuery(query, "userId") };
        },
        http: "GET",
        method: "listAccounts",
    },
    [`${AUTH_BASE}/passkeys`]: {
        build: ({ query }) => {
            return { userId: requireQuery(query, "userId") };
        },
        http: "GET",
        method: "listPasskeys",
    },
    [`${AUTH_BASE}/organizations`]: {
        build: ({ paging }) => {
            return { ...paging };
        },
        http: "GET",
        method: "listOrganizations",
    },
    [`${AUTH_BASE}/organizations/members`]: {
        build: ({ paging, query }) => {
            return { ...paging, organizationId: requireQuery(query, "organizationId") };
        },
        http: "GET",
        method: "listMembers",
    },
    [`${AUTH_BASE}/organizations/invitations`]: {
        build: ({ paging, query }) => {
            return { ...paging, organizationId: requireQuery(query, "organizationId") };
        },
        http: "GET",
        method: "listInvitations",
    },

    // --- mutations (POST) -------------------------------------------------------
    [`${AUTH_BASE}/users/create`]: {
        build: ({ body }) => {
            return {
                data:
                    typeof body["data"] === "object" && body["data"] !== null && !Array.isArray(body["data"])
                        ? (body["data"] as Record<string, unknown>)
                        : undefined,
                email: requireBodyString(body, "email"),
                name: requireBodyString(body, "name"),
                password: optionalBodyString(body, "password"),
                role: parseRoleInput(body["role"]),
            };
        },
        http: "POST",
        method: "createUser",
    },
    [`${AUTH_BASE}/users/update`]: {
        build: ({ body }) => {
            const { data } = body;

            if (typeof data !== "object" || data === null || Array.isArray(data)) {
                throw new CirrusError("`data` object is required", { code: "BAD_REQUEST", status: 400 });
            }

            return { data: data as Record<string, unknown>, userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "updateUser",
    },
    [`${AUTH_BASE}/users/role`]: {
        build: ({ body }) => {
            const role = parseRoleInput(body["role"]);

            // Reject a missing role AND an empty/whitespace one — `setRole("")` would
            // otherwise clear the user's role rather than being a no-op.
            if (role === undefined || (typeof role === "string" && role.trim() === "")) {
                throw new CirrusError("`role` is required", { code: "BAD_REQUEST", status: 400 });
            }

            return { role, userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "setRole",
    },
    [`${AUTH_BASE}/users/ban`]: {
        build: ({ body }) => {
            return {
                expiresInSeconds: typeof body["expiresInSeconds"] === "number" ? body["expiresInSeconds"] : undefined,
                reason: optionalBodyString(body, "reason"),
                userId: requireBodyString(body, "userId"),
            };
        },
        http: "POST",
        method: "banUser",
    },
    [`${AUTH_BASE}/users/unban`]: {
        build: ({ body }) => {
            return { userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "unbanUser",
    },
    [`${AUTH_BASE}/users/password`]: {
        build: ({ body }) => {
            return { newPassword: requireBodyString(body, "newPassword"), userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "setUserPassword",
        returns: "void",
    },
    [`${AUTH_BASE}/users/remove`]: {
        build: ({ body }) => {
            return { userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "removeUser",
        returns: "void",
    },
    [`${AUTH_BASE}/users/impersonate`]: {
        build: ({ body }) => {
            return { userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "impersonateUser",
    },
    [`${AUTH_BASE}/sessions/revoke`]: {
        build: ({ body }) => {
            return { sessionId: requireBodyString(body, "sessionId") };
        },
        http: "POST",
        method: "revokeUserSession",
        returns: "void",
    },
    [`${AUTH_BASE}/sessions/revoke-all`]: {
        build: ({ body }) => {
            return { userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "revokeUserSessions",
        returns: "void",
    },
    [`${AUTH_BASE}/accounts/unlink`]: {
        build: ({ body }) => {
            return { accountId: requireBodyString(body, "accountId"), userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "unlinkAccount",
        returns: "void",
    },
    [`${AUTH_BASE}/two-factor/disable`]: {
        build: ({ body }) => {
            return { userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "disableTwoFactor",
        returns: "void",
    },
    [`${AUTH_BASE}/passkeys/delete`]: {
        build: ({ body }) => {
            return { passkeyId: requireBodyString(body, "passkeyId") };
        },
        http: "POST",
        method: "deletePasskey",
        returns: "void",
    },
    [`${AUTH_BASE}/organizations/members/remove`]: {
        build: ({ body }) => {
            return { memberId: requireBodyString(body, "memberId") };
        },
        http: "POST",
        method: "removeMember",
        returns: "void",
    },
    [`${AUTH_BASE}/organizations/invitations/cancel`]: {
        build: ({ body }) => {
            return { invitationId: requireBodyString(body, "invitationId") };
        },
        http: "POST",
        method: "cancelInvitation",
        returns: "void",
    },
};

/**
 * Build the `/_cirrus/admin/auth/*` route map merged into the worker's internal
 * route table. Every route shares one driver: admin-token gate → resolve the
 * auth plane → assert the method exists (`AUTH_OP_NOT_SUPPORTED` if the host
 * didn't wire it) → method guard → build input → run, mapping a thrown
 * `authAdmin` error onto a coded `CirrusError`.
 */
const buildAuthAdminRoutes = (deps: AuthAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const runAuthOp = async <R>(op: () => Promise<R>): Promise<R> => {
        try {
            return await op();
        } catch (error) {
            if (error instanceof CirrusError) {
                throw error;
            }

            const candidate = error as { code?: unknown; message?: unknown };
            const code = typeof candidate.code === "string" ? candidate.code : "AUTH_ADMIN_ERROR";
            const message = typeof candidate.message === "string" ? candidate.message : "auth admin operation failed";

            throw new CirrusError(message, { code, status: AUTH_ADMIN_ERROR_STATUS[code] ?? 400 });
        }
    };

    const handle = async (request: Request, descriptor: AuthRouteDescriptor): Promise<Response> => {
        if (request.method !== descriptor.http) {
            throw new CirrusError(`Auth admin endpoint requires ${descriptor.http}`, { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        deps.assertAdmin(request);

        const admin = deps.getAuthAdmin();

        if (admin === undefined) {
            throw new CirrusError("auth endpoints require an `authAdmin` on the worker", { code: "AUTH_NOT_CONFIGURED", status: 400 });
        }

        const method = admin[descriptor.method];

        if (method === undefined) {
            throw new CirrusError(`auth admin does not support \`${descriptor.method}\``, { code: "AUTH_OP_NOT_SUPPORTED", status: 400 });
        }

        const url = new URL(request.url);
        const context: AuthRouteContext = {
            body: descriptor.http === "POST" ? await deps.readJsonBody(request) : {},
            paging: deps.parsePaging(request),
            query: (name) => deps.queryParameter(url, name),
        };
        const input = descriptor.build(context);
        const result = await runAuthOp(() => (method as (argument: unknown) => Promise<unknown>)(input));

        return Response.json(descriptor.returns === "void" ? { ok: true } : result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const routes: Record<string, (request: Request) => Promise<Response>> = {};

    for (const [path, descriptor] of Object.entries(AUTH_ROUTES)) {
        routes[path] = (request: Request) => handle(request, descriptor);
    }

    return routes;
};

export type { AuthAdmin, AuthCapabilities, AuthImpersonation, AuthIntrospector, AuthPage, AuthSession, AuthTimestamp, AuthUser, ListAuthUsersOptions };
export { buildAuthAdminRoutes };
