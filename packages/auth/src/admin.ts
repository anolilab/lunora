import type { CirrusAuth } from "./create-auth";

/**
 * A timestamp as it leaves the admin API: epoch-ms (better-auth stores `Date`s,
 * which we normalize on output) or `null` when the column is unset.
 */
type AuthTimestamp = null | number;

/**
 * One user row as the admin API surfaces it. The fixed keys mirror better-auth's
 * core `user` table plus the `admin()` plugin columns (`role`/`banned`/…); the
 * index signature carries any app-defined `user.additionalFields` so callers
 * (the studio) can render them generically. Password material never lives on
 * this row (it's in the `account` table) and is never returned.
 */
interface AuthAdminUser {
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
    updatedAt?: AuthTimestamp;
}

/**
 * One session row as the admin API surfaces it. Mirrors better-auth's `session`
 * table; `impersonatedBy` is set when the session was minted by
 * {@link AuthAdmin.impersonateUser}. The signing `token` is stripped — it's a
 * bearer credential, and the only place we hand one back is the explicit
 * impersonation flow.
 */
interface AuthAdminSession {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    expiresAt?: AuthTimestamp;
    id: string;
    impersonatedBy?: null | string;
    ipAddress?: null | string;
    userAgent?: null | string;
    userId: string;
}

/** One linked account (a credential or OAuth provider). All token material is stripped. */
interface AuthAccount {
    [key: string]: unknown;
    accountId?: null | string;
    createdAt?: AuthTimestamp;
    id: string;
    providerId?: null | string;
    scope?: null | string;
    userId: string;
}

/** One organization row (from the `organization` plugin). */
interface AuthOrganization {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    id: string;
    name?: null | string;
    slug?: null | string;
}

/** One organization membership row. */
interface AuthMember {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    id: string;
    organizationId: string;
    role?: null | string;
    userId: string;
}

/** One pending organization invitation. */
interface AuthInvitation {
    [key: string]: unknown;
    email?: null | string;
    expiresAt?: AuthTimestamp;
    id: string;
    organizationId: string;
    role?: null | string;
    status?: null | string;
}

/** One registered passkey. Credential secrets (`publicKey`) are stripped. */
interface AuthPasskey {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    deviceType?: null | string;
    id: string;
    name?: null | string;
    userId: string;
}

/** A page of rows plus the unpaginated total. */
interface AuthPage<T> {
    rows: T[];
    total: number;
}

/**
 * Which admin surfaces a given auth instance supports, derived from the enabled
 * better-auth plugins (and any {@link CreateAuthAdminOptions.features} overrides).
 * The studio calls {@link AuthAdmin.capabilities} once and renders only the
 * panels whose capability is `true` — so a deployment that doesn't enable, say,
 * the `organization` plugin never shows an Organizations section.
 */
interface AuthCapabilities {
    /** Linked-account browsing/unlinking — core (the `account` table always exists). */
    accounts: boolean;
    /** The `admin()` plugin: ban/role/impersonate/create/delete/set-password. */
    admin: boolean;
    /** The `organization` plugin: orgs, members, invitations. */
    organization: boolean;
    /** The `@better-auth/passkey` plugin: per-user passkeys. */
    passkey: boolean;
    /** The `two-factor` plugin: per-user 2FA status / disable. */
    twoFactor: boolean;
}

/** A scalar value usable in an adapter `where` clause / filter. */
type WhereValue = boolean | number | string;

/** One adapter `where` clause built by the list endpoints. */
interface WhereClause {
    field: string;
    operator?: "contains" | "eq";
    value: WhereValue;
}

/** Filtering / paging options for {@link AuthAdmin.listUsers}. */
interface ListUsersOptions {
    /** Column to filter on with `=` (defaults to `email` when `filterValue` is set). */
    filterField?: string;
    /** Exact-match filter value. */
    filterValue?: WhereValue;
    limit?: number;
    offset?: number;
    /** Substring search value (matched with `contains`). */
    search?: string;
    /** Column the `search` substring matches against (default `email`). */
    searchField?: string;
    /** Column to order by (default `createdAt`). */
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

/** The result of {@link AuthAdmin.impersonateUser}: a fresh session token to act as the target user. */
interface ImpersonationResult {
    expiresAt: AuthTimestamp;
    /** Bearer session token for the impersonated user. The caller is responsible for using it (e.g. setting the cookie). */
    token: string;
    user: AuthAdminUser;
}

/**
 * The full read + write surface the studio's auth dashboard drives, backed by
 * better-auth's tables. Returned by {@link createAuthAdmin}. The runtime accepts
 * a structurally-compatible object as its `authAdmin` option and exposes each
 * method behind an admin-token-gated endpoint. Methods whose backing plugin is
 * absent still exist (they're not conditionally omitted) but the studio gates
 * them on {@link AuthAdmin.capabilities}; calling one for an unconfigured plugin
 * surfaces the underlying adapter error.
 */
interface AuthAdmin {
    banUser: (input: { expiresInSeconds?: number; reason?: string; userId: string }) => Promise<AuthAdminUser>;
    cancelInvitation: (input: { invitationId: string }) => Promise<void>;
    capabilities: () => Promise<AuthCapabilities>;
    createUser: (input: { data?: Record<string, unknown>; email: string; name: string; password?: string; role?: string | string[] }) => Promise<AuthAdminUser>;
    deletePasskey: (input: { passkeyId: string }) => Promise<void>;
    disableTwoFactor: (input: { userId: string }) => Promise<void>;
    impersonateUser: (input: { userId: string }) => Promise<ImpersonationResult>;
    listAccounts: (input: { userId: string }) => Promise<AuthAccount[]>;
    listInvitations: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthInvitation>>;
    listMembers: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthMember>>;
    listOrganizations: (options: { limit?: number; offset?: number }) => Promise<AuthPage<AuthOrganization>>;
    listPasskeys: (input: { userId: string }) => Promise<AuthPasskey[]>;
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthAdminSession>>;
    listUsers: (options: ListUsersOptions) => Promise<AuthPage<AuthAdminUser>>;
    removeMember: (input: { memberId: string }) => Promise<void>;
    removeUser: (input: { userId: string }) => Promise<void>;
    revokeUserSession: (input: { sessionId: string }) => Promise<void>;
    revokeUserSessions: (input: { userId: string }) => Promise<void>;
    setRole: (input: { role: string | string[]; userId: string }) => Promise<AuthAdminUser>;
    setUserPassword: (input: { newPassword: string; userId: string }) => Promise<void>;
    unbanUser: (input: { userId: string }) => Promise<AuthAdminUser>;
    unlinkAccount: (input: { accountId: string; userId: string }) => Promise<void>;
    updateUser: (input: { data: Record<string, unknown>; userId: string }) => Promise<AuthAdminUser>;
}

/** Options for {@link createAuthAdmin}. */
interface CreateAuthAdminOptions {
    /**
     * Force individual {@link AuthCapabilities} on or off regardless of which
     * plugins are detected — e.g. `{ impersonate: false }`-style opt-outs by
     * setting `admin: false`, or hiding linked accounts with `accounts: false`.
     * A capability is reported only when both its plugin is enabled *and* its
     * override isn't `false`.
     */
    features?: Partial<AuthCapabilities>;

    /**
     * User id recorded as the impersonator on sessions minted by
     * {@link AuthAdmin.impersonateUser}. Defaults to the impersonated user's own
     * id (a self-reference) since the trusted admin plane has no acting user.
     */
    impersonatedBy?: string;

    /**
     * How long (in seconds) an impersonation session lives. Must be a positive
     * finite integer. Capped at 24 × {@link DEFAULT_IMPERSONATION_SECONDS}
     * (86 400 s / 24 h). Defaults to {@link DEFAULT_IMPERSONATION_SECONDS}
     * (3 600 s / 1 h).
     */
    impersonationSeconds?: number;
}

/**
 * A normalized failure from an admin operation. better-auth throws `APIError`s
 * carrying a `body.code` (e.g. `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`); we
 * surface that `code` so the runtime can map it onto an HTTP status and the
 * studio can show a meaningful message instead of a generic 500.
 */
class CirrusAuthAdminError extends Error {
    public readonly code: string;

    public constructor(message: string, code: string) {
        super(message);
        this.name = "CirrusAuthAdminError";
        this.code = code;
    }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_IMPERSONATION_SECONDS = 3600;
/** Hard ceiling on an impersonation session (24 h). */
const MAX_IMPERSONATION_SECONDS = DEFAULT_IMPERSONATION_SECONDS * 24;
/** Hard ceiling on a temporary-ban duration so a huge value can't overflow to an Invalid Date. */
const MAX_BAN_SECONDS = 100 * 365 * 24 * 60 * 60;

/**
 * Columns never handed back to a browser across any model: bearer credentials,
 * password hashes, OAuth tokens, and 2FA secrets. A denylist (not an allowlist)
 * so app-defined `additionalFields` still pass through; the names cover the
 * secret-bearing columns of better-auth core + the admin/organization/passkey/
 * two-factor plugin tables.
 */
const SENSITIVE_FIELDS = new Set(["accessToken", "backupCodes", "idToken", "password", "publicKey", "refreshToken", "secret", "token"]);

const clampLimit = (limit?: number): number => Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
const clampOffset = (offset?: number): number => Math.max(0, Math.trunc(offset ?? 0));

/** Shape a raw adapter row for transport: drop sensitive columns, turn `Date`s into epoch-ms. */
const normalizeRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (SENSITIVE_FIELDS.has(key)) {
            continue;
        }

        out[key] = value instanceof Date ? value.getTime() : value;
    }

    return out;
};

/** Mirror better-auth's admin plugin, which stores a multi-role value as a comma-joined string. */
const serializeRole = (role: string | string[]): string => (Array.isArray(role) ? role.join(",") : role);

/**
 * Re-throw an unknown error as a {@link CirrusAuthAdminError}, lifting a
 * better-auth `APIError`'s `body.code` when present so the caller sees a stable
 * machine code rather than an opaque message.
 */
const asAdminError = (error: unknown): CirrusAuthAdminError => {
    if (error instanceof CirrusAuthAdminError) {
        return error;
    }

    const candidate = error as { body?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
    const code = candidate?.body?.code ?? candidate?.code ?? "AUTH_ADMIN_ERROR";
    const message = candidate?.body?.message ?? candidate?.message ?? "auth admin operation failed";

    return new CirrusAuthAdminError(message, code);
};

/**
 * Build the studio's auth user-management plane on top of better-auth.
 *
 * Pass the result as the runtime's `authAdmin` option; the runtime exposes each
 * method behind an admin-token-gated `/_cirrus/admin/auth/*` endpoint. The set
 * of usable surfaces is reported by {@link AuthAdmin.capabilities} — derived
 * from the enabled better-auth plugins, so enabling `admin()`, `organization()`,
 * `twoFactor()`, or the passkey plugin in the auth config is what lights up the
 * matching dashboard panels.
 *
 * **Trust model — important.** These operations talk to better-auth's
 * `internalAdapter` (and `adapter`/password hasher) **directly**, deliberately
 * bypassing the plugins' own endpoints, which require the caller to hold an
 * admin-role session. That session check is the wrong gate here: the runtime
 * already authorizes every call with `CIRRUS_ADMIN_TOKEN`, so this helper acts
 * as a trusted server-side operator. It is therefore not an end-user-callable
 * API — never expose it on a path that isn't admin-token gated.
 *
 * `auth.$context` is a promise (better-auth resolves the adapter, password
 * config, etc. lazily); we memoize it so the first call pays the cost once.
 */
const createAuthAdmin = (auth: CirrusAuth, options: CreateAuthAdminOptions = {}): AuthAdmin => {
    // `auth.$context` is a single resolved-once promise; holding the reference
    // memoizes the (lazy) adapter/password-config resolution across calls.
    const context = auth.$context;
    const features = options.features ?? {};

    /** Resolve the better-auth context once, then run `fn`, normalizing any thrown `APIError`. */
    const withContext = async <R>(function_: (context_: Awaited<CirrusAuth["$context"]>) => Promise<R>): Promise<R> => {
        try {
            return await function_(await context);
        } catch (error) {
            throw asAdminError(error);
        }
    };

    const toUser = (row: Record<string, unknown>): AuthAdminUser => normalizeRow(row) as AuthAdminUser;

    /** Page a model via the raw adapter with optional where/sort; shared by every list endpoint. */
    const page = async <T>(
        context_: Awaited<CirrusAuth["$context"]>,
        model: string,
        options_: { limit?: number; offset?: number; sortBy?: { direction: "asc" | "desc"; field: string }; where?: WhereClause[] },
    ): Promise<AuthPage<T>> => {
        const where = options_.where && options_.where.length > 0 ? options_.where : undefined;
        const [rows, total] = await Promise.all([
            context_.adapter.findMany<Record<string, unknown>>({
                limit: clampLimit(options_.limit),
                model,
                offset: clampOffset(options_.offset),
                sortBy: options_.sortBy,
                where,
            }),
            context_.adapter.count({ model, where }),
        ]);

        return { rows: rows.map((row) => normalizeRow(row) as T), total };
    };

    return {
        banUser: ({ expiresInSeconds, reason, userId }) =>
            withContext(async (context_) => {
                // Clamp to a sane finite ceiling so a huge/NaN value can't overflow to an Invalid Date.
                const seconds =
                    typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) ? Math.min(Math.trunc(expiresInSeconds), MAX_BAN_SECONDS) : 0;
                const banExpires = seconds > 0 ? new Date(Date.now() + seconds * 1000) : undefined;
                const user = await context_.internalAdapter.updateUser(userId, {
                    banExpires,
                    banned: true,
                    banReason: reason ?? "No reason",
                });

                // Mirror the plugin: a ban revokes the user's live sessions.
                await context_.internalAdapter.deleteUserSessions(userId);

                return toUser(user as Record<string, unknown>);
            }),

        cancelInvitation: ({ invitationId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "invitation", where: [{ field: "id", value: invitationId }] });
            }),

        capabilities: () =>
            withContext((context_) => {
                const ids = new Set((context_.options.plugins ?? []).map((plugin) => plugin.id));
                const has = (id: string): boolean => ids.has(id);

                return Promise.resolve({
                    accounts: features.accounts ?? true,
                    admin: features.admin ?? has("admin"),
                    organization: features.organization ?? has("organization"),
                    passkey: features.passkey ?? has("passkey"),
                    twoFactor: features.twoFactor ?? has("two-factor"),
                });
            }),

        // The one op that genuinely builds a row rather than mutating one. Replicates
        // the plugin's create-user handler over `internalAdapter` (lowercase + dedupe
        // email, create the row, then link a credential account when a password is given).
        createUser: ({ data, email, name, password, role }) =>
            withContext(async (context_) => {
                const normalizedEmail = email.toLowerCase();

                if (await context_.internalAdapter.findUserByEmail(normalizedEmail)) {
                    throw new CirrusAuthAdminError("a user with this email already exists", "USER_ALREADY_EXISTS");
                }

                // `data` carries app-defined `additionalFields`. It is spread last and so
                // can override `role` (matching the better-auth admin plugin's `createUser`);
                // this is acceptable because the whole plane is admin-token gated.
                const user = await context_.internalAdapter.createUser({
                    email: normalizedEmail,
                    name,
                    role: role === undefined ? undefined : serializeRole(role),
                    ...data,
                } as Parameters<typeof context_.internalAdapter.createUser>[0]);

                if (password !== undefined && password !== "") {
                    const hashed = await context_.password.hash(password);

                    await context_.internalAdapter.linkAccount({
                        accountId: user.id,
                        password: hashed,
                        providerId: "credential",
                        userId: user.id,
                    });
                }

                return toUser(user as Record<string, unknown>);
            }),

        deletePasskey: ({ passkeyId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "passkey", where: [{ field: "id", value: passkeyId }] });
            }),

        disableTwoFactor: ({ userId }) =>
            withContext(async (context_) => {
                await context_.adapter.deleteMany({ model: "twoFactor", where: [{ field: "userId", value: userId }] });
                await context_.internalAdapter.updateUser(userId, { twoFactorEnabled: false });
            }),

        impersonateUser: ({ userId }) =>
            withContext(async (context_) => {
                const user = await context_.internalAdapter.findUserById(userId);

                if (!user) {
                    throw new CirrusAuthAdminError("user not found", "USER_NOT_FOUND");
                }

                const rawSeconds = options.impersonationSeconds;
                let ttlSeconds = DEFAULT_IMPERSONATION_SECONDS;

                if (rawSeconds !== undefined) {
                    if (!Number.isInteger(rawSeconds) || !Number.isFinite(rawSeconds) || rawSeconds <= 0) {
                        throw new CirrusAuthAdminError(
                            "impersonationSeconds must be a positive finite integer",
                            "INVALID_IMPERSONATION_SECONDS",
                        );
                    }

                    ttlSeconds = Math.min(rawSeconds, MAX_IMPERSONATION_SECONDS);
                }
                const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
                const session = await context_.internalAdapter.createSession(
                    userId,
                    true,
                    { expiresAt, impersonatedBy: options.impersonatedBy ?? userId },
                    true,
                );

                return {
                    expiresAt: session.expiresAt instanceof Date ? session.expiresAt.getTime() : expiresAt.getTime(),
                    token: session.token,
                    user: toUser(user),
                };
            }),

        listAccounts: ({ userId }) =>
            withContext(async (context_) => {
                const rows = await context_.adapter.findMany<Record<string, unknown>>({ model: "account", where: [{ field: "userId", value: userId }] });

                return rows.map((row) => normalizeRow(row) as AuthAccount);
            }),

        listInvitations: ({ limit, offset, organizationId }) =>
            withContext((context_) =>
                page<AuthInvitation>(context_, "invitation", {
                    limit,
                    offset,
                    where: [{ field: "organizationId", value: organizationId }],
                }),
            ),

        listMembers: ({ limit, offset, organizationId }) =>
            withContext((context_) =>
                page<AuthMember>(context_, "member", {
                    limit,
                    offset,
                    sortBy: { direction: "desc", field: "createdAt" },
                    where: [{ field: "organizationId", value: organizationId }],
                }),
            ),

        listOrganizations: ({ limit, offset }) =>
            withContext((context_) => page<AuthOrganization>(context_, "organization", { limit, offset, sortBy: { direction: "desc", field: "createdAt" } })),

        listPasskeys: ({ userId }) =>
            withContext(async (context_) => {
                const rows = await context_.adapter.findMany<Record<string, unknown>>({ model: "passkey", where: [{ field: "userId", value: userId }] });

                return rows.map((row) => normalizeRow(row) as AuthPasskey);
            }),

        listSessions: ({ limit, offset, userId }) =>
            withContext((context_) =>
                page<AuthAdminSession>(context_, "session", {
                    limit,
                    offset,
                    sortBy: { direction: "desc", field: "createdAt" },
                    where: userId === undefined || userId === "" ? undefined : [{ field: "userId", value: userId }],
                }),
            ),

        listUsers: ({ filterField, filterValue, limit, offset, search, searchField, sortBy, sortDirection }) =>
            withContext((context_) => {
                const where: WhereClause[] = [];

                if (search !== undefined && search !== "") {
                    where.push({ field: searchField ?? "email", operator: "contains", value: search });
                }

                if (filterValue !== undefined) {
                    where.push({ field: filterField ?? "email", operator: "eq", value: filterValue });
                }

                return page<AuthAdminUser>(context_, "user", {
                    limit,
                    offset,
                    sortBy: { direction: sortDirection ?? "desc", field: sortBy ?? "createdAt" },
                    where,
                });
            }),

        removeMember: ({ memberId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "member", where: [{ field: "id", value: memberId }] });
            }),

        removeUser: ({ userId }) =>
            withContext(async (context_) => {
                await context_.internalAdapter.deleteUserSessions(userId);
                await context_.internalAdapter.deleteUser(userId);
            }),

        // Keyed on the session *id*, not its token: tokens are bearer credentials we
        // deliberately never surface to the studio. Resolve the row to recover its
        // token, then delete via `internalAdapter.deleteSession` — which also clears
        // secondary (KV) storage, unlike a raw `adapter.delete` on the DB row.
        revokeUserSession: ({ sessionId }) =>
            withContext(async (context_) => {
                const session = await context_.adapter.findOne<{ token?: string }>({ model: "session", where: [{ field: "id", value: sessionId }] });

                if (session?.token) {
                    await context_.internalAdapter.deleteSession(session.token);
                }
            }),

        revokeUserSessions: ({ userId }) =>
            withContext(async (context_) => {
                await context_.internalAdapter.deleteUserSessions(userId);
            }),

        setRole: ({ role, userId }) =>
            withContext(async (context_) => {
                const user = await context_.internalAdapter.updateUser(userId, { role: serializeRole(role) });

                return toUser(user as Record<string, unknown>);
            }),

        setUserPassword: ({ newPassword, userId }) =>
            withContext(async (context_) => {
                const min = context_.password.config.minPasswordLength;
                const max = context_.password.config.maxPasswordLength;

                if (newPassword.length < min) {
                    throw new CirrusAuthAdminError(`password must be at least ${min.toString()} characters`, "PASSWORD_TOO_SHORT");
                }

                if (newPassword.length > max) {
                    throw new CirrusAuthAdminError(`password must be at most ${max.toString()} characters`, "PASSWORD_TOO_LONG");
                }

                const hashed = await context_.password.hash(newPassword);

                await context_.internalAdapter.updatePassword(userId, hashed);
            }),

        unbanUser: ({ userId }) =>
            withContext(async (context_) => {
                // `null` (not `undefined`) so the adapter clears the columns rather than skipping them.
                // eslint-disable-next-line unicorn/no-null -- DB columns must be explicitly nulled to clear a ban
                const user = await context_.internalAdapter.updateUser(userId, { banExpires: null, banned: false, banReason: null });

                return toUser(user as Record<string, unknown>);
            }),

        unlinkAccount: ({ accountId, userId }) =>
            withContext(async (context_) => {
                // Scope the delete to the owning user so an `accountId` can't reach another user's row.
                await context_.adapter.delete({
                    model: "account",
                    where: [
                        { field: "id", value: accountId },
                        { connector: "AND", field: "userId", value: userId },
                    ],
                });
            }),

        updateUser: ({ data, userId }) =>
            withContext(async (context_) => {
                const user = await context_.internalAdapter.updateUser(userId, data);

                return toUser(user as Record<string, unknown>);
            }),
    };
};

export type {
    AuthAccount,
    AuthAdmin,
    AuthAdminSession,
    AuthAdminUser,
    AuthCapabilities,
    AuthInvitation,
    AuthMember,
    AuthOrganization,
    AuthPage,
    AuthPasskey,
    AuthTimestamp,
    CreateAuthAdminOptions,
    ImpersonationResult,
    ListUsersOptions,
};
export { CirrusAuthAdminError, createAuthAdmin };
