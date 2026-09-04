import { createLocalAccountIssuer } from "@better-auth/core/db";
import { LunoraError } from "@lunora/errors";
import { getAuthTables } from "better-auth/db";

import type { LunoraAuth } from "./create-auth";
// Aliased: this module exposes methods of the same names, and a method body
// calling an identically-named import is a needless double-take.
import { createSignUpInvitation as issueSignUpInvitation, revokeSignUpInvitation as withdrawSignUpInvitation } from "./invite-only";

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

/**
 * One sign-up invitation (from the `inviteOnly` plugin). Distinct from
 * {@link AuthInvitation}, which invites an existing account into an organization:
 * this one is what lets an address create an account at all.
 */
interface AuthSignUpInvitation {
    [key: string]: unknown;
    /** When an account was created for this address; `null` while the invitation is unspent. */
    acceptedAt?: AuthTimestamp;
    createdAt?: AuthTimestamp;
    email?: null | string;
    expiresAt?: AuthTimestamp;
    id: string;
    invitedBy?: null | string;
}

/** One team row (from the `organization` plugin with `teams.enabled`). */
interface AuthTeam {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    id: string;
    name?: null | string;
    organizationId: string;
}

/** One team-membership row (teams). */
interface AuthTeamMember {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    id: string;
    teamId: string;
    userId: string;
}

/**
 * One custom organization role (from the organization plugin's dynamic
 * access-control). `permission` is a JSON string of a `resource → actions[]` map
 * as stored; the studio parses it for display/editing.
 */
interface AuthOrgRole {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    id: string;
    organizationId: string;
    permission?: null | string;
    role?: null | string;
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
    /** The `inviteOnly` plugin: sign-up invitations. */
    inviteOnly: boolean;
    /** The `organization` plugin: orgs, members, invitations. */
    organization: boolean;
    /** The `@better-auth/passkey` plugin: per-user passkeys. */
    passkey: boolean;
    /** The `two-factor` plugin: per-user 2FA status / disable. */
    twoFactor: boolean;
}

/**
 * One app/plugin-defined field the create-user form should render, derived from
 * the merged better-auth `user` table (core + plugin + `additionalFields`). Only
 * user-settable columns are surfaced — server-managed flags (`input: false`),
 * foreign keys (`references`), and the core columns the form already handles
 * (`email`/`name`/`role`/ban state/…) are filtered out upstream.
 */
interface AuthUserFieldSpec {
    /** Logical field name (the key passed back in `createUser`'s `data`). */
    name: string;
    /** Best-effort plugin id the field originates from (`username`, `phone-number`, …); `undefined` for app `additionalFields`. */
    plugin?: string;
    required: boolean;
    /** Coarse input kind the studio maps to a control (checkbox / number / date / text). */
    type: "boolean" | "date" | "number" | "string";
    unique: boolean;
}

/**
 * A rich, read-only description of the deployment's auth configuration for the
 * studio's config panel and dynamic create-user form. Unlike
 * {@link AuthCapabilities} (five booleans that gate panels), this exposes *what*
 * is configured — enabled plugins, email/password + social sign-in, the
 * user-settable fields, organization sub-features (teams / custom roles), and
 * the session + rate-limit policy — without ever leaking a secret.
 */
interface AuthConfigInfo {
    /** The same capability booleans {@link AuthAdmin.capabilities} returns, embedded so a single call drives the whole panel. */
    capabilities: AuthCapabilities;
    /** Whether email + password sign-in is enabled. */
    emailAndPassword: boolean;
    /** Organization plugin sub-features. */
    organization: {
        enabled: boolean;
        /** Custom roles / dynamic access control (`organizationRole` table present). */
        roles: boolean;
        /** Teams (`team` table present). */
        teams: boolean;
    };
    /** Enabled better-auth plugin ids, sorted. */
    plugins: string[];
    /** Rate-limit policy (window is in seconds). */
    rateLimit: { enabled: boolean; max?: number; window?: number };
    /** Session policy (all durations in seconds). */
    session: { cookieCache?: boolean; expiresIn?: number; freshAge?: number; updateAge?: number };
    /** Configured social/OAuth provider ids, sorted. */
    socialProviders: string[];
    /** User-settable extra fields for the create-user form (plugin + app `additionalFields`). */
    userFields: AuthUserFieldSpec[];
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
    /** Directly add an existing user as an org member (server-side, no invitation/acceptance). */
    addMember: (input: { organizationId: string; role?: string; userId: string }) => Promise<AuthMember>;
    /** Add a user to a team. */
    addTeamMember: (input: { teamId: string; userId: string }) => Promise<AuthTeamMember>;
    banUser: (input: { expiresInSeconds?: number; reason?: string; userId: string }) => Promise<AuthAdminUser>;
    cancelInvitation: (input: { invitationId: string }) => Promise<void>;
    capabilities: () => Promise<AuthCapabilities>;
    /** Rich, read-only description of the auth configuration (plugins, fields, session policy, …). */
    config: () => Promise<AuthConfigInfo>;
    /** Create an organization; optionally seed an `owner` member for `ownerId`. */
    createOrganization: (input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name: string;
        ownerId?: string;
        slug?: string;
    }) => Promise<AuthOrganization>;
    /** Create a custom org role with a permission grant (a `resource → actions[]` map). */
    createOrgRole: (input: { organizationId: string; permission: Record<string, string[]>; role: string }) => Promise<AuthOrgRole>;

    /**
     * Invite an address to sign up, or refresh an existing invitation for it.
     * Needs the `inviteOnly` plugin — without it the row is written to a table
     * nothing reads, which is why the studio gates the panel on
     * {@link AuthCapabilities.inviteOnly}.
     */
    createSignUpInvitation: (input: { email: string; expiresInSeconds?: number; invitedBy?: string }) => Promise<AuthSignUpInvitation>;
    /** Create a team under an organization. */
    createTeam: (input: { name: string; organizationId: string }) => Promise<AuthTeam>;
    createUser: (input: { data?: Record<string, unknown>; email: string; name: string; password?: string; role?: string | string[] }) => Promise<AuthAdminUser>;
    /** Delete an organization and cascade-delete its members, invitations, teams, and custom roles. */
    deleteOrganization: (input: { organizationId: string }) => Promise<void>;
    /** Delete a custom org role. */
    deleteOrgRole: (input: { roleId: string }) => Promise<void>;
    deletePasskey: (input: { passkeyId: string }) => Promise<void>;
    disableTwoFactor: (input: { userId: string }) => Promise<void>;
    impersonateUser: (input: { userId: string }) => Promise<ImpersonationResult>;
    /** Create a pending email invitation to an org (no acceptance side effects). */
    inviteMember: (input: { email: string; inviterId?: string; organizationId: string; role?: string }) => Promise<AuthInvitation>;
    listAccounts: (input: { userId: string }) => Promise<AuthAccount[]>;
    listInvitations: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthInvitation>>;
    listMembers: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthMember>>;
    listOrganizations: (options: { limit?: number; offset?: number }) => Promise<AuthPage<AuthOrganization>>;
    /** List an org's custom roles. */
    listOrgRoles: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthOrgRole>>;
    listPasskeys: (input: { userId: string }) => Promise<AuthPasskey[]>;
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthAdminSession>>;

    /**
     * Sign-up invitations, newest first. Unfiltered on purpose: "pending" is
     * `acceptedAt === null && expiresAt > now`, and applying that after a page
     * would let page 1 come back empty while pending rows sat on page 2. The
     * caller has both columns and can label each row itself.
     */
    listSignUpInvitations: (options: { limit?: number; offset?: number }) => Promise<AuthPage<AuthSignUpInvitation>>;
    /** List a team's members. */
    listTeamMembers: (options: { limit?: number; offset?: number; teamId: string }) => Promise<AuthPage<AuthTeamMember>>;
    /** List an org's teams. */
    listTeams: (options: { limit?: number; offset?: number; organizationId: string }) => Promise<AuthPage<AuthTeam>>;
    listUsers: (options: ListUsersOptions) => Promise<AuthPage<AuthAdminUser>>;
    removeMember: (input: { memberId: string }) => Promise<void>;
    /** Delete a team and its memberships. */
    removeTeam: (input: { teamId: string }) => Promise<void>;
    /** Remove a member from a team. */
    removeTeamMember: (input: { teamMemberId: string }) => Promise<void>;
    removeUser: (input: { userId: string }) => Promise<void>;
    /** Withdraw a sign-up invitation. Not retroactive — an account already created keeps existing; use {@link AuthAdmin.removeUser} for that. */
    revokeSignUpInvitation: (input: { email: string }) => Promise<void>;
    revokeUserSession: (input: { sessionId: string }) => Promise<void>;
    revokeUserSessions: (input: { userId: string }) => Promise<void>;
    setRole: (input: { role: string | string[]; userId: string }) => Promise<AuthAdminUser>;
    setUserPassword: (input: { newPassword: string; userId: string }) => Promise<void>;
    unbanUser: (input: { userId: string }) => Promise<AuthAdminUser>;
    unlinkAccount: (input: { accountId: string; userId: string }) => Promise<void>;
    /** Change a member's role. */
    updateMemberRole: (input: { memberId: string; role: string | string[] }) => Promise<AuthMember>;
    /** Update an organization's name/slug/logo/metadata. */
    updateOrganization: (input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        organizationId: string;
        slug?: string;
    }) => Promise<AuthOrganization>;
    /** Replace a custom org role's permission grant. */
    updateOrgRole: (input: { permission: Record<string, string[]>; roleId: string }) => Promise<AuthOrgRole>;
    /** Rename a team. */
    updateTeam: (input: { name: string; teamId: string }) => Promise<AuthTeam>;
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
class LunoraAuthAdminError extends LunoraError {
    public constructor(message: string, code: string) {
        super(code, message, { name: "LunoraAuthAdminError" });
    }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_IMPERSONATION_SECONDS = 3600;
/** Hard ceiling on an impersonation session (24 h). */
const MAX_IMPERSONATION_SECONDS = DEFAULT_IMPERSONATION_SECONDS * 24;
/** Hard ceiling on a temporary-ban duration so a huge value can't overflow to an Invalid Date. */
const MAX_BAN_SECONDS = 100 * 365 * 24 * 60 * 60;
/** How long an admin-created org invitation stays valid (48 h), mirroring the plugin default. */
const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Plugin tables `removeUser` unwinds, each gated on the model actually being
 * installed. None of these declare `onDelete: "cascade"` in better-auth's schema
 * (only `session` and `account` do), so nothing removes them even on an
 * FK-enforcing backend — and D1 has FK enforcement off entirely.
 *
 * The `oauth*` and `deviceCode` rows are the sharp end: an `oauthAccessToken` is a
 * bearer credential a third party can present as the deleted user until its own
 * expiry, and a refresh token mints fresh ones. `deleteUserSessions` reaches only
 * the session-bound ones.
 *
 * `invitation` is keyed on `inviterId` — invitations the user *sent*; ones
 * addressed **to** them are keyed by email, not user, and deliberately stay. Audit
 * log rows are absent by design too (forensics outlive the account).
 *
 * Deliberately NOT here: `ssoProvider` and `oauthClient`. Their `userId` is the
 * admin who *registered* a tenant-wide resource (a SAML/OIDC domain config, a
 * dynamically-registered OAuth client), not a credential belonging to that user —
 * removing them would break login for every OTHER user of that domain or app.
 */
const USER_CASCADE = [
    { field: "userId", model: "member" },
    { field: "userId", model: "teamMember" },
    { field: "userId", model: "passkey" },
    { field: "userId", model: "twoFactor" },
    { field: "userId", model: "oauthAccessToken" },
    { field: "userId", model: "oauthRefreshToken" },
    { field: "userId", model: "oauthConsent" },
    { field: "userId", model: "deviceCode" },
    { field: "userId", model: "walletAddress" },
    { field: "inviterId", model: "invitation" },
] as const;

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

/** A URL-safe slug from a name — lowercase, non-alphanumerics collapsed to single hyphens, trimmed. */
const slugify = (value: string): string =>
    value
        .toLowerCase()
        .replaceAll(/[^\da-z]+/g, "-")
        // Runs are already collapsed to a single "-", so trimming one leading/trailing
        // hyphen suffices — no `+` quantifier (which trips the ReDoS lint) is needed.
        .replaceAll(/^-|-$/g, "");

/**
 * Core `user` columns the create-user form handles explicitly (or that are
 * server-managed) and so must be excluded from the derived "extra fields" list,
 * even though they're not flagged `input: false`. `image` is deliberately *not*
 * here — an admin may want to set an avatar URL.
 */
const CORE_USER_FIELDS = new Set(["banExpires", "banned", "banReason", "createdAt", "email", "emailVerified", "id", "name", "role", "updatedAt"]);

/** Best-effort field → originating-plugin labels, purely for nicer UI grouping. */
const USER_FIELD_PLUGIN: Record<string, string> = {
    displayUsername: "username",
    phoneNumber: "phone-number",
    phoneNumberVerified: "phone-number",
    username: "username",
};

/** Collapse a better-auth field `type` to the coarse input kind the studio renders. */
const mapUserFieldType = (type: unknown): AuthUserFieldSpec["type"] => (type === "boolean" || type === "date" || type === "number" ? type : "string");

/**
 * Derive the user-settable extra fields for the create-user form from the merged
 * better-auth `user` table. Skips server-managed columns (`input: false`),
 * foreign keys (`references`), and the core columns the form already handles.
 */
const buildUserFields = (
    userFields: Record<string, { input?: boolean; references?: unknown; required?: boolean; type?: unknown; unique?: boolean }>,
): AuthUserFieldSpec[] => {
    const out: AuthUserFieldSpec[] = [];

    for (const [name, attribute] of Object.entries(userFields)) {
        if (attribute.input === false || attribute.references !== undefined || CORE_USER_FIELDS.has(name)) {
            continue;
        }

        out.push({
            name,
            plugin: USER_FIELD_PLUGIN[name],
            required: attribute.required === true,
            type: mapUserFieldType(attribute.type),
            unique: attribute.unique === true,
        });
    }

    return out;
};

/** Roles are stored as a comma-joined string, so an owner is matched by substring — the convention already used elsewhere in this file. */
const isOwnerRole = (role: unknown): boolean => typeof role === "string" && role.includes("owner");

/**
 * Refuse to delete a user who is the only owner left in an organization.
 *
 * `removeUser` unwinds `member` rows, so without this the org survives with zero
 * owners: nobody can administer it, invite to it, or delete it, and the operator
 * gets no signal that it happened. Transferring ownership or calling
 * `deleteOrganization` first are both explicit acts; silently orphaning an org is
 * not one of them.
 */
const assertNotLastOwner = async (context_: Awaited<LunoraAuth["$context"]>, userId: string): Promise<void> => {
    const memberships = await context_.adapter.findMany<{ organizationId?: string; role?: string }>({
        model: "member",
        where: [{ field: "userId", value: userId }],
    });

    const ownedOrgIds = memberships.filter((row) => isOwnerRole(row.role) && typeof row.organizationId === "string").map((row) => row.organizationId as string);

    if (ownedOrgIds.length === 0) {
        return;
    }

    const rosters = await Promise.all(
        ownedOrgIds.map(async (organizationId) =>
            context_.adapter.findMany<{ role?: string; userId?: string }>({
                model: "member",
                where: [{ field: "organizationId", value: organizationId }],
            }),
        ),
    );

    const orphaned = ownedOrgIds.find((_, index) => !rosters[index]?.some((row) => row.userId !== userId && isOwnerRole(row.role)));

    if (orphaned !== undefined) {
        throw new LunoraAuthAdminError(
            `user is the last owner of organization ${orphaned} — transfer ownership or delete the organization first`,
            "LAST_ORGANIZATION_OWNER",
        );
    }
};

/**
 * Re-throw an unknown error as a {@link LunoraAuthAdminError}, lifting a
 * better-auth `APIError`'s `body.code` when present so the caller sees a stable
 * machine code rather than an opaque message.
 */
const asAdminError = (error: unknown): LunoraAuthAdminError => {
    if (error instanceof LunoraAuthAdminError) {
        return error;
    }

    const candidate = error as { body?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
    const code = candidate?.body?.code ?? candidate?.code ?? "AUTH_ADMIN_ERROR";
    const message = candidate?.body?.message ?? candidate?.message ?? "auth admin operation failed";

    return new LunoraAuthAdminError(message, code);
};

/**
 * Build the studio's auth user-management plane on top of better-auth.
 *
 * Pass the result as the runtime's `authAdmin` option; the runtime exposes each
 * method behind an admin-token-gated `/_lunora/admin/auth/*` endpoint. The set
 * of usable surfaces is reported by {@link AuthAdmin.capabilities} — derived
 * from the enabled better-auth plugins, so enabling `admin()`, `organization()`,
 * `twoFactor()`, or the passkey plugin in the auth config is what lights up the
 * matching dashboard panels.
 *
 * **Trust model — important.** These operations talk to better-auth's
 * `internalAdapter` (and `adapter`/password hasher) **directly**, deliberately
 * bypassing the plugins' own endpoints, which require the caller to hold an
 * admin-role session. That session check is the wrong gate here: the runtime
 * already authorizes every call with `LUNORA_ADMIN_TOKEN`, so this helper acts
 * as a trusted server-side operator. It is therefore not an end-user-callable
 * API — never expose it on a path that isn't admin-token gated.
 *
 * `auth.$context` is a promise (better-auth resolves the adapter, password
 * config, etc. lazily); we memoize it so the first call pays the cost once.
 */
const createAuthAdmin = (auth: LunoraAuth, options: CreateAuthAdminOptions = {}): AuthAdmin => {
    // `auth.$context` is a single resolved-once promise; holding the reference
    // memoizes the (lazy) adapter/password-config resolution across calls.
    const context = auth.$context;
    const features = options.features ?? {};

    /** Derive the five capability booleans from the enabled plugin ids + `features` overrides. Single source shared by `capabilities()` and `config()` so the config panel and the capability gate can't drift. */
    const deriveCapabilities = (authOptions: Awaited<LunoraAuth["$context"]>["options"]): AuthCapabilities => {
        const ids = new Set((authOptions.plugins ?? []).map((plugin) => plugin.id));
        const has = (id: string): boolean => ids.has(id);

        return {
            accounts: features.accounts ?? true,
            admin: features.admin ?? has("admin"),
            inviteOnly: features.inviteOnly ?? has("lunora-invite-only"),
            organization: features.organization ?? has("organization"),
            passkey: features.passkey ?? has("passkey"),
            twoFactor: features.twoFactor ?? has("two-factor"),
        };
    };

    /** Resolve the better-auth context once, then run `fn`, normalizing any thrown `APIError`. */
    const withContext = async <R>(function_: (context_: Awaited<LunoraAuth["$context"]>) => Promise<R>): Promise<R> => {
        try {
            return await function_(await context);
        } catch (error) {
            throw asAdminError(error);
        }
    };

    const toUser = (row: Record<string, unknown>): AuthAdminUser => normalizeRow(row) as AuthAdminUser;

    /** Page a model via the raw adapter with optional where/sort; shared by every list endpoint. */
    const page = async <T>(
        context_: Awaited<LunoraAuth["$context"]>,
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
                // Omitting `expiresInSeconds` is a permanent ban; a provided-but-non-positive/
                // non-finite value is a caller error (mirrors impersonateUser) rather than a
                // silent permanent ban. Clamp valid values to a sane finite ceiling so a huge
                // value can't overflow to an Invalid Date.
                // eslint-disable-next-line unicorn/no-null -- permanent ban must explicitly null banExpires (see below)
                let banExpires: Date | null = null;

                if (expiresInSeconds !== undefined) {
                    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
                        throw new LunoraAuthAdminError("expiresInSeconds must be a positive finite integer", "INVALID_BAN_SECONDS");
                    }

                    const seconds = Math.min(expiresInSeconds, MAX_BAN_SECONDS);

                    banExpires = new Date(Date.now() + seconds * 1000);
                }

                const user = await context_.internalAdapter.updateUser(userId, {
                    // `null` (not `undefined`) for a permanent ban so the adapter clears any prior
                    // `banExpires` rather than skipping it — otherwise a temp-ban-then-permanent-ban
                    // escalation leaves the old expiry and the "permanent" ban silently lapses.
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

        capabilities: () => withContext((context_) => Promise.resolve(deriveCapabilities(context_.options))),

        // ── Directly add an existing user to an org (no invitation/acceptance). ──
        addMember: ({ organizationId, role, userId }) =>
            withContext(async (context_) => {
                const member = await context_.adapter.create({
                    data: { createdAt: new Date(), organizationId, role: role === undefined || role === "" ? "member" : role, userId },
                    model: "member",
                });

                return normalizeRow(member) as AuthMember;
            }),

        addTeamMember: ({ teamId, userId }) =>
            withContext(async (context_) => {
                const teamMember = await context_.adapter.create({
                    data: { createdAt: new Date(), teamId, userId },
                    model: "teamMember",
                });

                return normalizeRow(teamMember) as AuthTeamMember;
            }),

        // Rich introspection for the config panel + dynamic create-user form. Reads
        // only from the resolved better-auth options (no DB, no secrets).
        config: () =>
            withContext((context_) => {
                const authOptions = context_.options;
                const capabilities = deriveCapabilities(authOptions);
                const ids = new Set((authOptions.plugins ?? []).map((plugin) => plugin.id));

                const tables = getAuthTables(authOptions);
                const session = authOptions.session ?? {};
                const rateLimit = authOptions.rateLimit ?? {};

                return Promise.resolve({
                    capabilities,
                    emailAndPassword: authOptions.emailAndPassword?.enabled ?? false,
                    organization: {
                        enabled: capabilities.organization,
                        roles: Boolean(tables["organizationRole"]),
                        teams: Boolean(tables["team"]),
                    },
                    plugins: [...ids].toSorted((a, b) => a.localeCompare(b)),
                    rateLimit: { enabled: rateLimit.enabled ?? false, max: rateLimit.max, window: rateLimit.window },
                    session: {
                        cookieCache: session.cookieCache?.enabled,
                        expiresIn: session.expiresIn,
                        freshAge: session.freshAge,
                        updateAge: session.updateAge,
                    },
                    socialProviders: Object.keys(authOptions.socialProviders ?? {}).toSorted((a, b) => a.localeCompare(b)),
                    userFields: buildUserFields((tables["user"]?.fields ?? {}) as Parameters<typeof buildUserFields>[0]),
                });
            }),

        createOrganization: ({ logo, metadata, name, ownerId, slug }) =>
            withContext(async (context_) => {
                const finalSlug = slug !== undefined && slug !== "" ? slugify(slug) : slugify(name);

                if (finalSlug === "") {
                    throw new LunoraAuthAdminError("could not derive a slug from the organization name", "ORG_SLUG_INVALID");
                }

                const existing = await context_.adapter.findOne<Record<string, unknown>>({
                    model: "organization",
                    where: [{ field: "slug", value: finalSlug }],
                });

                if (existing) {
                    throw new LunoraAuthAdminError("an organization with this slug already exists", "ORG_SLUG_TAKEN");
                }

                const organization = await context_.adapter.create({
                    data: {
                        createdAt: new Date(),
                        logo: logo === undefined || logo === "" ? undefined : logo,
                        metadata: metadata === undefined ? undefined : JSON.stringify(metadata),
                        name,
                        slug: finalSlug,
                    },
                    model: "organization",
                });

                if (ownerId !== undefined && ownerId !== "") {
                    await context_.adapter.create({
                        data: { createdAt: new Date(), organizationId: (organization as { id: string }).id, role: "owner", userId: ownerId },
                        model: "member",
                    });
                }

                return normalizeRow(organization) as AuthOrganization;
            }),

        createOrgRole: ({ organizationId, permission, role }) =>
            withContext(async (context_) => {
                const created = await context_.adapter.create({
                    data: { createdAt: new Date(), organizationId, permission: JSON.stringify(permission), role },
                    model: "organizationRole",
                });

                return normalizeRow(created) as AuthOrgRole;
            }),

        createTeam: ({ name, organizationId }) =>
            withContext(async (context_) => {
                const team = await context_.adapter.create({
                    data: { createdAt: new Date(), name, organizationId },
                    model: "team",
                });

                return normalizeRow(team) as AuthTeam;
            }),

        deleteOrganization: ({ organizationId }) =>
            withContext(async (context_) => {
                const tables = getAuthTables(context_.options);

                await context_.adapter.deleteMany({ model: "member", where: [{ field: "organizationId", value: organizationId }] });
                await context_.adapter.deleteMany({ model: "invitation", where: [{ field: "organizationId", value: organizationId }] });

                // FK cascade may be off (D1), so unwind teams → team members explicitly.
                if (tables["team"]) {
                    const teams = await context_.adapter.findMany<{ id: string }>({
                        model: "team",
                        where: [{ field: "organizationId", value: organizationId }],
                    });

                    for (const team of teams) {
                        // eslint-disable-next-line no-await-in-loop -- sequential per-team cascade; team counts are small
                        await context_.adapter.deleteMany({ model: "teamMember", where: [{ field: "teamId", value: team.id }] });
                    }

                    await context_.adapter.deleteMany({ model: "team", where: [{ field: "organizationId", value: organizationId }] });
                }

                if (tables["organizationRole"]) {
                    await context_.adapter.deleteMany({ model: "organizationRole", where: [{ field: "organizationId", value: organizationId }] });
                }

                await context_.adapter.delete({ model: "organization", where: [{ field: "id", value: organizationId }] });
            }),

        deleteOrgRole: ({ roleId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "organizationRole", where: [{ field: "id", value: roleId }] });
            }),

        // Create a pending email invitation. `inviterId` is DB-required; when the
        // caller omits it, attribute the invite to the org's owner (else any member).
        inviteMember: ({ email, inviterId, organizationId, role }) =>
            withContext(async (context_) => {
                let resolvedInviter = inviterId;

                if (resolvedInviter === undefined || resolvedInviter === "") {
                    const members = await context_.adapter.findMany<{ role?: string; userId?: string }>({
                        model: "member",
                        where: [{ field: "organizationId", value: organizationId }],
                    });
                    const owner = members.find((member) => typeof member.role === "string" && member.role.includes("owner"));

                    resolvedInviter = (owner ?? members[0])?.userId;
                }

                if (resolvedInviter === undefined || resolvedInviter === "") {
                    throw new LunoraAuthAdminError("provide an inviter — the organization has no members to attribute the invitation to", "INVITER_REQUIRED");
                }

                const invitation = await context_.adapter.create({
                    data: {
                        createdAt: new Date(),
                        email: email.toLowerCase(),
                        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
                        inviterId: resolvedInviter,
                        organizationId,
                        role: role === undefined || role === "" ? "member" : role,
                        status: "pending",
                    },
                    model: "invitation",
                });

                return normalizeRow(invitation) as AuthInvitation;
            }),

        listOrgRoles: ({ limit, offset, organizationId }) =>
            withContext((context_) =>
                page<AuthOrgRole>(context_, "organizationRole", {
                    limit,
                    offset,
                    sortBy: { direction: "desc", field: "createdAt" },
                    where: [{ field: "organizationId", value: organizationId }],
                }),
            ),

        listTeamMembers: ({ limit, offset, teamId }) =>
            withContext((context_) =>
                page<AuthTeamMember>(context_, "teamMember", {
                    limit,
                    offset,
                    where: [{ field: "teamId", value: teamId }],
                }),
            ),

        listTeams: ({ limit, offset, organizationId }) =>
            withContext((context_) =>
                page<AuthTeam>(context_, "team", {
                    limit,
                    offset,
                    sortBy: { direction: "desc", field: "createdAt" },
                    where: [{ field: "organizationId", value: organizationId }],
                }),
            ),

        removeTeam: ({ teamId }) =>
            withContext(async (context_) => {
                await context_.adapter.deleteMany({ model: "teamMember", where: [{ field: "teamId", value: teamId }] });
                await context_.adapter.delete({ model: "team", where: [{ field: "id", value: teamId }] });
            }),

        removeTeamMember: ({ teamMemberId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "teamMember", where: [{ field: "id", value: teamMemberId }] });
            }),

        updateMemberRole: ({ memberId, role }) =>
            withContext(async (context_) => {
                const member = await context_.adapter.update<Record<string, unknown>>({
                    model: "member",
                    update: { role: serializeRole(role) },
                    where: [{ field: "id", value: memberId }],
                });

                // A `null` result means the adapter didn't echo the row (some adapters
                // don't on `update`), NOT that no row matched `memberId` — synthesize the
                // updated row from the inputs rather than treat it as not-found.
                return normalizeRow(member ?? { id: memberId, role: serializeRole(role) }) as AuthMember;
            }),

        updateOrganization: ({ logo, metadata, name, organizationId, slug }) =>
            withContext(async (context_) => {
                const update: Record<string, unknown> = {};

                if (name !== undefined) {
                    update["name"] = name;
                }

                if (slug !== undefined && slug !== "") {
                    update["slug"] = slugify(slug);
                }

                if (logo !== undefined) {
                    update["logo"] = logo === "" ? undefined : logo;
                }

                if (metadata !== undefined) {
                    update["metadata"] = JSON.stringify(metadata);
                }

                // No updatable field was supplied (e.g. the edit dialog submitted with
                // every field left blank): skip the adapter call — some adapters reject
                // an empty `update` with a driver error — and report the id back as a
                // no-op success.
                if (Object.keys(update).length === 0) {
                    return normalizeRow({ id: organizationId }) as AuthOrganization;
                }

                const organization = await context_.adapter.update<Record<string, unknown>>({
                    model: "organization",
                    update,
                    where: [{ field: "id", value: organizationId }],
                });

                // A `null` result means the adapter didn't echo the row, NOT that no row
                // matched `organizationId` — synthesize a minimal success row rather than
                // treat it as not-found.
                return normalizeRow(organization ?? { id: organizationId }) as AuthOrganization;
            }),

        updateOrgRole: ({ permission, roleId }) =>
            withContext(async (context_) => {
                const updated = await context_.adapter.update<Record<string, unknown>>({
                    model: "organizationRole",
                    update: { permission: JSON.stringify(permission), updatedAt: new Date() },
                    where: [{ field: "id", value: roleId }],
                });

                // A `null` result means the adapter didn't echo the row, NOT that no row
                // matched `roleId` — synthesize the updated row from the inputs rather
                // than treat it as not-found.
                return normalizeRow(updated ?? { id: roleId, permission: JSON.stringify(permission) }) as AuthOrgRole;
            }),

        updateTeam: ({ name, teamId }) =>
            withContext(async (context_) => {
                const team = await context_.adapter.update<Record<string, unknown>>({
                    model: "team",
                    update: { name, updatedAt: new Date() },
                    where: [{ field: "id", value: teamId }],
                });

                // A `null` result means the adapter didn't echo the row, NOT that no row
                // matched `teamId` — synthesize the updated row from the inputs rather
                // than treat it as not-found.
                return normalizeRow(team ?? { id: teamId, name }) as AuthTeam;
            }),

        // The one op that genuinely builds a row rather than mutating one. Replicates
        // the plugin's create-user handler over `internalAdapter` (lowercase + dedupe
        // email, create the row, then link a credential account when a password is given).
        createUser: ({ data, email, name, password, role }) =>
            withContext(async (context_) => {
                const normalizedEmail = email.toLowerCase();

                if (await context_.internalAdapter.findUserByEmail(normalizedEmail)) {
                    throw new LunoraAuthAdminError("a user with this email already exists", "USER_ALREADY_EXISTS");
                }

                // `data` carries app-defined `additionalFields`. It is spread last and so
                // can override `role` (matching the better-auth admin plugin's `createUser`);
                // this is acceptable because the whole plane is admin-token gated.
                const user = await context_.internalAdapter.createUser(
                    {
                        email: normalizedEmail,
                        name,
                        role: role === undefined ? undefined : serializeRole(role),
                        ...data,
                    } as Parameters<typeof context_.internalAdapter.createUser>[0],
                    // better-auth 1.7 takes the caller's provenance as a second argument
                    // (it reaches database hooks); this whole plane is admin-token gated,
                    // so it reports itself the same way better-auth's own admin plugin does.
                    { method: "admin" },
                );

                if (password !== undefined && password !== "") {
                    const hashed = await context_.password.hash(password);

                    await context_.internalAdapter.linkAccount({
                        // 1.7 made `issuer` required and scoped an account by
                        // `(issuer, accountId)` rather than `accountId` alone; for a local
                        // password account the issuer is derived from the provider id
                        // rather than being a remote IdP. (1.7.0's prereleases also
                        // renamed the column to `providerAccountId`; GA reverted that, so
                        // `accountId` is the field name again.)
                        accountId: user.id,
                        issuer: createLocalAccountIssuer("credential"),
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
                    throw new LunoraAuthAdminError("user not found", "USER_NOT_FOUND");
                }

                const rawSeconds = options.impersonationSeconds;
                let ttlSeconds = DEFAULT_IMPERSONATION_SECONDS;

                if (rawSeconds !== undefined) {
                    if (!Number.isInteger(rawSeconds) || !Number.isFinite(rawSeconds) || rawSeconds <= 0) {
                        throw new LunoraAuthAdminError("impersonationSeconds must be a positive finite integer", "INVALID_IMPERSONATION_SECONDS");
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

        // Delegates to `./invite-only.ts` rather than re-implementing the upsert:
        // the validation, the TTL ceiling and the unique-index fallback all live
        // with the plugin that owns the table. Only the timestamp shape is this
        // layer's business — the admin plane hands back epoch-ms, like every other
        // row it returns.
        createSignUpInvitation: ({ email, expiresInSeconds, invitedBy }) =>
            withContext(async () => normalizeRow({ ...(await issueSignUpInvitation(auth, { email, expiresInSeconds, invitedBy })) }) as AuthSignUpInvitation),

        listSignUpInvitations: ({ limit, offset }) =>
            withContext((context_) =>
                page<AuthSignUpInvitation>(context_, "signUpInvitation", {
                    limit,
                    offset,
                    sortBy: { direction: "desc", field: "createdAt" },
                }),
            ),

        revokeSignUpInvitation: ({ email }) => withContext(async () => withdrawSignUpInvitation(auth, { email })),

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

        // `internalAdapter.deleteUser` removes only `session`/`account`/`user` rows.
        // FK cascade may be off (D1), so unwind {@link USER_CASCADE} explicitly —
        // orphaned `twoFactor` rows would retain the TOTP secret and backup codes of
        // an account that no longer exists.
        //
        // The cascade is several non-atomic writes ending in `deleteUser`, so a
        // mid-failure leaves a partially-cascaded user; every step is idempotent, so
        // re-running `removeUser` is the recovery.
        removeUser: ({ userId }) =>
            withContext(async (context_) => {
                const tables = getAuthTables(context_.options);

                if (tables["member"]) {
                    await assertNotLastOwner(context_, userId);
                }

                await Promise.all(
                    USER_CASCADE.filter(({ model }) => tables[model]).map(({ field, model }) =>
                        context_.adapter.deleteMany({ model, where: [{ field, value: userId }] }),
                    ),
                );

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
                    throw new LunoraAuthAdminError(`password must be at least ${min.toString()} characters`, "PASSWORD_TOO_SHORT");
                }

                if (newPassword.length > max) {
                    throw new LunoraAuthAdminError(`password must be at most ${max.toString()} characters`, "PASSWORD_TOO_LONG");
                }

                // Existence first: hashing is a deliberately expensive KDF, and an
                // unknown user should not be able to make the admin plane pay it.
                if (!(await context_.internalAdapter.findUserById(userId))) {
                    throw new LunoraAuthAdminError("user not found", "USER_NOT_FOUND");
                }

                // `updatePassword` is an updateMany filtered on `providerId: "credential"`
                // — zero matching rows is a silent no-op. A user created without a
                // password (or via OAuth) has no credential account yet, so create it.
                const accounts = await context_.internalAdapter.findAccounts(userId);
                const hasCredential = accounts.some((account) => account.providerId === "credential");

                // Creating one on a deployment with email+password turned off would
                // plant a password login that goes live the day the feature is enabled.
                // Rotating an EXISTING credential stays allowed — that account was a
                // deliberate act whenever it was made.
                if (!hasCredential && context_.options.emailAndPassword?.enabled !== true) {
                    throw new LunoraAuthAdminError("email/password sign-in is disabled for this deployment", "EMAIL_PASSWORD_DISABLED");
                }

                const hashed = await context_.password.hash(newPassword);

                if (hasCredential) {
                    await context_.internalAdapter.updatePassword(userId, hashed);
                } else {
                    await context_.internalAdapter.linkAccount({
                        // `accountId`, not the `providerAccountId` 1.7.0's prereleases
                        // briefly used — GA reverted that rename. Same shape as the
                        // create-user path above.
                        accountId: userId,
                        issuer: createLocalAccountIssuer("credential"),
                        password: hashed,
                        providerId: "credential",
                        userId,
                    });
                }
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
    AuthConfigInfo,
    AuthInvitation,
    AuthMember,
    AuthOrganization,
    AuthOrgRole,
    AuthPage,
    AuthPasskey,
    AuthSignUpInvitation,
    AuthTeam,
    AuthTeamMember,
    AuthTimestamp,
    AuthUserFieldSpec,
    CreateAuthAdminOptions,
    ImpersonationResult,
    ListUsersOptions,
};
export { createAuthAdmin, LunoraAuthAdminError };
