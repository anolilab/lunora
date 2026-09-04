import { LunoraError } from "./errors";

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
    inviteOnly: boolean;
    organization: boolean;
    passkey: boolean;
    twoFactor: boolean;
}

/** One user-settable extra field for the create-user form, derived from the merged `user` table. */
interface AuthUserFieldSpec {
    name: string;
    plugin?: string;
    required: boolean;
    type: "boolean" | "date" | "number" | "string";
    unique: boolean;
}

/**
 * Rich, read-only description of the deployment's auth configuration — enabled
 * plugins, sign-in methods, user-settable fields, organization sub-features, and
 * session / rate-limit policy — for the studio's config panel and dynamic
 * create-user form. Never carries a secret.
 */
interface AuthConfigInfo {
    capabilities: AuthCapabilities;
    emailAndPassword: boolean;
    organization: { enabled: boolean; roles: boolean; teams: boolean };
    plugins: string[];
    rateLimit: { enabled: boolean; max?: number; window?: number };
    session: { cookieCache?: boolean; expiresIn?: number; freshAge?: number; updateAge?: number };
    socialProviders: string[];
    userFields: AuthUserFieldSpec[];
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
 * wires this to better-auth (typically via `@lunora/auth`'s `createAuthAdmin`);
 * the runtime stays free of a hard dependency on `@lunora/auth`. The read
 * methods back the GET browse endpoints; the optional mutations back the
 * admin-gated POST endpoints — a host that only needs read-only browsing can
 * omit them (the POST routes then respond `AUTH_OP_NOT_SUPPORTED`). Omit the
 * whole option and every `/auth/*` endpoint responds `AUTH_NOT_CONFIGURED`.
 *
 * Every method here runs behind the worker's `LUNORA_ADMIN_TOKEN` gate — the
 * implementation is a trusted server-side operator, not an end-user API.
 */
interface AuthAdmin {
    addMember?: (input: { organizationId: string; role?: string; userId: string }) => Promise<Record<string, unknown>>;
    addTeamMember?: (input: { teamId: string; userId: string }) => Promise<Record<string, unknown>>;
    banUser?: (input: { expiresInSeconds?: number; reason?: string; userId: string }) => Promise<AuthUser>;
    cancelInvitation?: (input: { invitationId: string }) => Promise<void>;
    capabilities?: () => Promise<AuthCapabilities>;
    config?: () => Promise<AuthConfigInfo>;
    createOrganization?: (input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name: string;
        ownerId?: string;
        slug?: string;
    }) => Promise<Record<string, unknown>>;
    createOrgRole?: (input: { organizationId: string; permission: Record<string, string[]>; role: string }) => Promise<Record<string, unknown>>;
    createSignUpInvitation?: (input: { email: string; expiresInSeconds?: number; invitedBy?: string }) => Promise<Record<string, unknown>>;
    createTeam?: (input: { name: string; organizationId: string }) => Promise<Record<string, unknown>>;
    createUser?: (input: { data?: Record<string, unknown>; email: string; name: string; password?: string; role?: string | string[] }) => Promise<AuthUser>;
    deleteOrganization?: (input: { organizationId: string }) => Promise<void>;
    deleteOrgRole?: (input: { roleId: string }) => Promise<void>;
    deletePasskey?: (input: { passkeyId: string }) => Promise<void>;
    disableTwoFactor?: (input: { userId: string }) => Promise<void>;
    impersonateUser?: (input: { userId: string }) => Promise<AuthImpersonation>;
    inviteMember?: (input: { email: string; inviterId?: string; organizationId: string; role?: string }) => Promise<Record<string, unknown>>;
    listAccounts?: (input: { userId: string }) => Promise<Record<string, unknown>[]>;
    listInvitations?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listMembers?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listOrganizations?: (options: { limit?: number; offset?: number }) => Promise<AuthPage<Record<string, unknown>>>;
    listOrgRoles?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listPasskeys?: (input: { userId: string }) => Promise<Record<string, unknown>[]>;
    // `listUsers`/`listSessions` are the only required members: they're the
    // read-only browse surface every implementation must provide. Every other
    // op is optional and guarded at dispatch (`AUTH_OP_NOT_SUPPORTED`).
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>;
    listSignUpInvitations?: (options: { limit?: number; offset?: number }) => Promise<AuthPage<Record<string, unknown>>>;
    listTeamMembers?: (options: { limit?: number; offset?: number; teamId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listTeams?: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<Record<string, unknown>>>;
    listUsers: (options: ListAuthUsersOptions) => Promise<AuthPage<AuthUser>>;
    removeMember?: (input: { memberId: string }) => Promise<void>;
    removeTeam?: (input: { teamId: string }) => Promise<void>;
    removeTeamMember?: (input: { teamMemberId: string }) => Promise<void>;
    removeUser?: (input: { userId: string }) => Promise<void>;
    revokeSignUpInvitation?: (input: { email: string }) => Promise<void>;
    revokeUserSession?: (input: { sessionId: string }) => Promise<void>;
    revokeUserSessions?: (input: { userId: string }) => Promise<void>;
    setRole?: (input: { role: string | string[]; userId: string }) => Promise<AuthUser>;
    setUserPassword?: (input: { newPassword: string; userId: string }) => Promise<void>;
    unbanUser?: (input: { userId: string }) => Promise<AuthUser>;
    unlinkAccount?: (input: { accountId: string; userId: string }) => Promise<void>;
    updateMemberRole?: (input: { memberId: string; role: string | string[] }) => Promise<Record<string, unknown>>;
    updateOrganization?: (input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        organizationId: string;
        slug?: string;
    }) => Promise<Record<string, unknown>>;
    updateOrgRole?: (input: { permission: Record<string, string[]>; roleId: string }) => Promise<Record<string, unknown>>;
    updateTeam?: (input: { name: string; teamId: string }) => Promise<Record<string, unknown>>;
    updateUser?: (input: { data: Record<string, unknown>; userId: string }) => Promise<AuthUser>;
}

/** Closure-scoped worker helpers the auth routes borrow (so this module stays out of the worker's god-closure). */
interface AuthAdminRouteDeps {
    /** Throw 403 unless the request carries a valid admin bearer. */
    assertAdmin: (request: Request) => void;
    /** The configured auth plane (`authAdmin`), or undefined. */
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
    /** Build the method input from query (GET) or body (POST); throw `LunoraError` for invalid input. */
    build: (context: AuthRouteContext) => unknown;
    http: "GET" | "POST";
    method: keyof AuthAdmin;
    /** `void` mutations reply `{ ok: true }`; otherwise the method's return value is sent verbatim. */
    returns?: "value" | "void";
}

const AUTH_BASE = "/_lunora/admin/auth";

/** HTTP status for a known client-input `authAdmin` error code; an unmapped code is a backend failure and reads 500. */
const AUTH_ADMIN_ERROR_STATUS: Record<string, number> = {
    INVITER_REQUIRED: 400,
    ORG_SLUG_INVALID: 400,
    ORG_SLUG_TAKEN: 409,
    PASSWORD_TOO_LONG: 400,
    PASSWORD_TOO_SHORT: 400,
    USER_ALREADY_EXISTS: 409,
    USER_NOT_FOUND: 404,
};

/** Read a required non-empty string field off a parsed body, else 400. */
const requireBodyString = (body: Record<string, unknown>, field: string): string => {
    const value = body[field];

    if (typeof value !== "string" || value === "") {
        throw new LunoraError(`\`${field}\` is required`, { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/** Read a required query param, else 400. */
const requireQuery = (query: (name: string) => string | undefined, name: string): string => {
    const value = query(name);

    if (value === undefined) {
        throw new LunoraError(`\`${name}\` query parameter is required`, { code: "BAD_REQUEST", status: 400 });
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

/** Read an optional plain-object body field (rejects arrays/null), else `undefined`. */
const optionalBodyObject = (body: Record<string, unknown>, field: string): Record<string, unknown> | undefined => {
    const value = body[field];

    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
};

/**
 * Read + validate a required `role` off a body. Rejects a missing role AND an
 * empty/whitespace one — `setRole("")` would otherwise clear the user's role
 * rather than being a no-op.
 */
const requireRole = (body: Record<string, unknown>): string | string[] => {
    const role = parseRoleInput(body["role"]);

    if (role === undefined || (typeof role === "string" && role.trim() === "")) {
        throw new LunoraError("`role` is required", { code: "BAD_REQUEST", status: 400 });
    }

    return role;
};

/**
 * Read + validate a required `permission` grant off a body: a plain object whose
 * values are string arrays (a `resource → actions[]` map). Non-conforming entries
 * are dropped; a non-object throws 400.
 */
const requirePermission = (body: Record<string, unknown>): Record<string, string[]> => {
    const value = body["permission"];

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new LunoraError("`permission` object is required", { code: "BAD_REQUEST", status: 400 });
    }

    const out: Record<string, string[]> = {};

    for (const [resource, actions] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(actions) && actions.every((action): action is string => typeof action === "string")) {
            out[resource] = actions;
        }
    }

    return out;
};

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
    [`${AUTH_BASE}/sign-up-invitations`]: {
        build: ({ paging }) => {
            return { ...paging };
        },
        http: "GET",
        method: "listSignUpInvitations",
    },
    [`${AUTH_BASE}/sign-up-invitations/create`]: {
        build: ({ body }) => {
            return {
                email: requireBodyString(body, "email"),
                expiresInSeconds: typeof body["expiresInSeconds"] === "number" ? body["expiresInSeconds"] : undefined,
                invitedBy: optionalBodyString(body, "invitedBy"),
            };
        },
        http: "POST",
        method: "createSignUpInvitation",
    },
    [`${AUTH_BASE}/sign-up-invitations/revoke`]: {
        build: ({ body }) => {
            return { email: requireBodyString(body, "email") };
        },
        http: "POST",
        method: "revokeSignUpInvitation",
    },
    [`${AUTH_BASE}/config`]: {
        build: () => {
            return {};
        },
        http: "GET",
        method: "config",
    },
    [`${AUTH_BASE}/organizations/teams`]: {
        build: ({ paging, query }) => {
            return { ...paging, organizationId: requireQuery(query, "organizationId") };
        },
        http: "GET",
        method: "listTeams",
    },
    [`${AUTH_BASE}/organizations/teams/members`]: {
        build: ({ paging, query }) => {
            return { ...paging, teamId: requireQuery(query, "teamId") };
        },
        http: "GET",
        method: "listTeamMembers",
    },
    [`${AUTH_BASE}/organizations/roles`]: {
        build: ({ paging, query }) => {
            return { ...paging, organizationId: requireQuery(query, "organizationId") };
        },
        http: "GET",
        method: "listOrgRoles",
    },

    // --- mutations (POST) -------------------------------------------------------
    [`${AUTH_BASE}/users/create`]: {
        build: ({ body }) => {
            return {
                data: optionalBodyObject(body, "data"),
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
                throw new LunoraError("`data` object is required", { code: "BAD_REQUEST", status: 400 });
            }

            return { data: data as Record<string, unknown>, userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "updateUser",
    },
    [`${AUTH_BASE}/users/role`]: {
        build: ({ body }) => {
            return { role: requireRole(body), userId: requireBodyString(body, "userId") };
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
    [`${AUTH_BASE}/organizations/create`]: {
        build: ({ body }) => {
            return {
                logo: optionalBodyString(body, "logo"),
                metadata: optionalBodyObject(body, "metadata"),
                name: requireBodyString(body, "name"),
                ownerId: optionalBodyString(body, "ownerId"),
                slug: optionalBodyString(body, "slug"),
            };
        },
        http: "POST",
        method: "createOrganization",
    },
    [`${AUTH_BASE}/organizations/update`]: {
        build: ({ body }) => {
            return {
                logo: optionalBodyString(body, "logo"),
                metadata: optionalBodyObject(body, "metadata"),
                name: optionalBodyString(body, "name"),
                organizationId: requireBodyString(body, "organizationId"),
                slug: optionalBodyString(body, "slug"),
            };
        },
        http: "POST",
        method: "updateOrganization",
    },
    [`${AUTH_BASE}/organizations/remove`]: {
        build: ({ body }) => {
            return { organizationId: requireBodyString(body, "organizationId") };
        },
        http: "POST",
        method: "deleteOrganization",
        returns: "void",
    },
    [`${AUTH_BASE}/organizations/members/add`]: {
        build: ({ body }) => {
            return {
                organizationId: requireBodyString(body, "organizationId"),
                role: optionalBodyString(body, "role"),
                userId: requireBodyString(body, "userId"),
            };
        },
        http: "POST",
        method: "addMember",
    },
    [`${AUTH_BASE}/organizations/members/invite`]: {
        build: ({ body }) => {
            return {
                email: requireBodyString(body, "email"),
                inviterId: optionalBodyString(body, "inviterId"),
                organizationId: requireBodyString(body, "organizationId"),
                role: optionalBodyString(body, "role"),
            };
        },
        http: "POST",
        method: "inviteMember",
    },
    [`${AUTH_BASE}/organizations/members/role`]: {
        build: ({ body }) => {
            return { memberId: requireBodyString(body, "memberId"), role: requireRole(body) };
        },
        http: "POST",
        method: "updateMemberRole",
    },
    [`${AUTH_BASE}/organizations/teams/create`]: {
        build: ({ body }) => {
            return { name: requireBodyString(body, "name"), organizationId: requireBodyString(body, "organizationId") };
        },
        http: "POST",
        method: "createTeam",
    },
    [`${AUTH_BASE}/organizations/teams/update`]: {
        build: ({ body }) => {
            return { name: requireBodyString(body, "name"), teamId: requireBodyString(body, "teamId") };
        },
        http: "POST",
        method: "updateTeam",
    },
    [`${AUTH_BASE}/organizations/teams/remove`]: {
        build: ({ body }) => {
            return { teamId: requireBodyString(body, "teamId") };
        },
        http: "POST",
        method: "removeTeam",
        returns: "void",
    },
    [`${AUTH_BASE}/organizations/teams/members/add`]: {
        build: ({ body }) => {
            return { teamId: requireBodyString(body, "teamId"), userId: requireBodyString(body, "userId") };
        },
        http: "POST",
        method: "addTeamMember",
    },
    [`${AUTH_BASE}/organizations/teams/members/remove`]: {
        build: ({ body }) => {
            return { teamMemberId: requireBodyString(body, "teamMemberId") };
        },
        http: "POST",
        method: "removeTeamMember",
        returns: "void",
    },
    [`${AUTH_BASE}/organizations/roles/create`]: {
        build: ({ body }) => {
            return {
                organizationId: requireBodyString(body, "organizationId"),
                permission: requirePermission(body),
                role: requireBodyString(body, "role"),
            };
        },
        http: "POST",
        method: "createOrgRole",
    },
    [`${AUTH_BASE}/organizations/roles/update`]: {
        build: ({ body }) => {
            return { permission: requirePermission(body), roleId: requireBodyString(body, "roleId") };
        },
        http: "POST",
        method: "updateOrgRole",
    },
    [`${AUTH_BASE}/organizations/roles/remove`]: {
        build: ({ body }) => {
            return { roleId: requireBodyString(body, "roleId") };
        },
        http: "POST",
        method: "deleteOrgRole",
        returns: "void",
    },
};

/**
 * Build the `/_lunora/admin/auth/*` route map merged into the worker's internal
 * route table. Every route shares one driver: admin-token gate (FIRST, so an
 * unauthenticated probe can't fingerprint routes) → HTTP method guard → resolve
 * the auth plane → assert the method exists (`AUTH_OP_NOT_SUPPORTED` if the host
 * didn't wire it) → build input → run, mapping a thrown `authAdmin` error onto a
 * coded `LunoraError` with a generic (non-leaking) message.
 */
const buildAuthAdminRoutes = (deps: AuthAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const runAuthOp = async <R>(op: () => Promise<R>): Promise<R> => {
        try {
            return await op();
        } catch (error) {
            if (error instanceof LunoraError) {
                throw error;
            }

            const candidate = error as { code?: unknown; message?: unknown };
            const code = typeof candidate.code === "string" ? candidate.code : "AUTH_ADMIN_ERROR";

            // Do NOT surface the backend/DB error message to the client (even an
            // authenticated admin) — it can leak schema/driver internals. Log the
            // detail server-side and return a generic, code-tagged message, matching
            // the core `toErrorResponse` posture for unknown errors.
            // eslint-disable-next-line no-console -- server-side diagnostic for a swallowed backend error
            console.error("[lunora] auth admin operation failed:", error);

            // An unmapped code is an unexpected backend/DB failure, not client
            // input — reporting it as 400 would hide operational incidents from
            // admin tooling. Extend AUTH_ADMIN_ERROR_STATUS for new 4xx codes.
            throw new LunoraError("auth admin operation failed", { code, status: AUTH_ADMIN_ERROR_STATUS[code] ?? 500 });
        }
    };

    const handle = async (request: Request, descriptor: AuthRouteDescriptor): Promise<Response> => {
        // Assert admin BEFORE any method/existence check so an unauthenticated
        // caller can't distinguish real admin routes (would-be 405) from
        // non-existent paths — every admin path answers 403 without a token,
        // leaking no route topology.
        deps.assertAdmin(request);

        if (request.method !== descriptor.http) {
            throw new LunoraError(`Auth admin endpoint requires ${descriptor.http}`, { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const admin = deps.getAuthAdmin();

        if (admin === undefined) {
            throw new LunoraError("auth endpoints require an `authAdmin` on the worker", { code: "AUTH_NOT_CONFIGURED", status: 400 });
        }

        const method = admin[descriptor.method];

        if (method === undefined) {
            throw new LunoraError(`auth admin does not support \`${descriptor.method}\``, { code: "AUTH_OP_NOT_SUPPORTED", status: 400 });
        }

        const url = new URL(request.url);
        const context: AuthRouteContext = {
            body: descriptor.http === "POST" ? await deps.readJsonBody(request) : {},
            paging: deps.parsePaging(request),
            query: (name) => deps.queryParameter(url, name),
        };
        const input = descriptor.build(context);
        const result = await runAuthOp(() => (method as (argument: unknown) => Promise<unknown>)(input));

        // `no-store`, not just `content-type`: `users/impersonate` answers with a live
        // session bearer token for an arbitrary user and `users` with PII. Under an
        // `adminGate` the request carries a cookie/JWT and no `Authorization` header,
        // so RFC 9111's shared-cache suppression does not apply — nothing else would
        // stop an intermediary storing it. Mirrors the inline admin routes.
        return Response.json(descriptor.returns === "void" ? { ok: true } : result, {
            headers: { "cache-control": "no-store", "content-type": "application/json" },
            status: 200,
        });
    };

    const routes: Record<string, (request: Request) => Promise<Response>> = {};

    for (const [path, descriptor] of Object.entries(AUTH_ROUTES)) {
        routes[path] = (request: Request) => handle(request, descriptor);
    }

    return routes;
};

export type {
    AuthAdmin,
    AuthCapabilities,
    AuthConfigInfo,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthTimestamp,
    AuthUser,
    AuthUserFieldSpec,
    ListAuthUsersOptions,
};
export { buildAuthAdminRoutes };
