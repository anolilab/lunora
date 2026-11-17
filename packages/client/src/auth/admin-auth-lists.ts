import type { LunoraAdminClient } from "../admin/admin-client";
import type { LunoraClient } from "../lunora-client";
import type { AuthImpersonation, AuthPage, AuthSession, AuthUser } from "../types";

/**
 * Framework-neutral core of the admin/organization list hooks (plan 237). The
 * auth-admin reads are HTTP-only (`adminFetch`), so they cannot ride the live
 * transport; an adapter wraps each {@link AdminAuthList} in its own one-shot
 * query primitive with an explicit refetch and a growing `{ limit }` window.
 *
 * What lives here is what a second adapter would otherwise re-derive wrong:
 * the per-list request builders, the cache key (which partitions by the acting
 * identity), the identity-change subscription, and the `hasMore` rule.
 */

/** Query-key namespace, distinct from the live `["lunora", …]` keys and Studio's `["lunora-admin", …]` / `["lunora-auth-*"]` keys, so an app embedding both never collides. */
const ADMIN_AUTH_LIST_NAMESPACE = "lunora-admin-auth-list";

/** Default page size for the first read; a "load more" grows the requested window by the page size. */
const ADMIN_AUTH_DEFAULT_PAGE_SIZE = 50;

/** One paged admin-auth collection: the key that identifies its inputs, and how to read a `{ limit }` window from the top. */
interface AdminAuthList<T> {
    /** Read the first `limit` rows. `AuthPage` is offset/limit-based, so a larger window re-reads from the top rather than appending. */
    readonly fetchPage: (limit: number) => Promise<AuthPage<T>>;
    /** Every input that should invalidate the cache — not `fetchPage`, which is a fresh closure per call. */
    readonly key: ReadonlyArray<unknown>;
}

/** Search / filter / sort inputs for {@link authUsersList}. */
interface AuthUsersListFilter {
    filterField?: string;
    filterValue?: string;
    search?: string;
    searchField?: string;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

/** Users, via the admin-gated `GET /_lunora/admin/auth/users` (`client.listAuthUsers`). */
const authUsersList = (client: LunoraAdminClient, filter: AuthUsersListFilter = {}): AdminAuthList<AuthUser> => {
    const { filterField, filterValue, search, searchField, sortBy, sortDirection } = filter;

    return {
        fetchPage: (limit) => client.listAuthUsers({ filterField, filterValue, limit, search, searchField, sortBy, sortDirection }),
        // TanStack hashes keys with deterministic, key-sorted JSON, so the filter object is the key slot.
        key: ["users", { filterField, filterValue, search, searchField, sortBy, sortDirection }],
    };
};

/** Organizations (better-auth `organization` plugin), via `client.listAuthOrganizations`. */
const authOrganizationsList = (client: LunoraAdminClient): AdminAuthList<Record<string, unknown>> => {
    return { fetchPage: (limit) => client.listAuthOrganizations({ limit }), key: ["organizations"] };
};

/** Sign-up invitations (`inviteOnly` plugin), via `client.listAuthSignUpInvitations`. Rows are unfiltered and newest-first. */
const authSignUpInvitationsList = (client: LunoraAdminClient): AdminAuthList<Record<string, unknown>> => {
    return { fetchPage: (limit) => client.listAuthSignUpInvitations({ limit }), key: ["sign-up-invitations"] };
};

/** Auth sessions, optionally scoped to one user, via `client.listAuthSessions`. */
const authSessionsList = (client: LunoraAdminClient, options: { userId?: string } = {}): AdminAuthList<AuthSession> => {
    const { userId } = options;

    return { fetchPage: (limit) => client.listAuthSessions({ limit, userId }), key: ["sessions", { userId }] };
};

/**
 * The cache key for one window of an admin list: `[namespace, identity, ...list.key, limit]`.
 *
 * The acting identity (slot 1) partitions the cache, or a credential swap on the
 * same client (admin A → admin B) would serve A's cached rows to B until the
 * refetch lands. It is `client.currentIdentity()` — a `subj:` label or a
 * non-reversible token hash — never the bearer token: query keys are not
 * private (persisters write them to `localStorage`, devtools render them,
 * telemetry logs them), and a same-user token refresh keeps the same key.
 *
 * An adapter that keeps the previous window visible while a larger one loads
 * must only do so when slot 1 is unchanged, so one identity's rows never stand
 * in for another's.
 */
const adminAuthListQueryKey = (identity: string | null, list: AdminAuthList<unknown>, limit: number): ReadonlyArray<unknown> => [
    ADMIN_AUTH_LIST_NAMESPACE,
    identity ?? "anon",
    ...list.key,
    limit,
];

/**
 * Subscribe to every change of `client.currentIdentity()`. Both signals are
 * needed: a bearer swap fires `onAuthTokenChange`, while a cookie session's
 * user switch or sign-out fires only `onIdentityChange` (no token changes
 * hands) — subscribing to one leaves the other's previous rows on screen.
 */
const subscribeAdminAuthIdentity = (client: LunoraClient, onChange: () => void): (() => void) => {
    const offToken = client.onAuthTokenChange(onChange);
    const offIdentity = client.onIdentityChange(onChange);

    return () => {
        offToken();
        offIdentity();
    };
};

/** `true` when the server reports rows beyond the loaded window; `false` before the first page resolves, so "load more" past the end is a no-op. */
const adminAuthListHasMore = (page: AuthPage<unknown> | undefined): boolean => page !== undefined && page.rows.length < page.total;

/** Query options for one window of an admin list, spread into a TanStack hook (the `lunoraQueryOptions` pattern). */
interface AdminAuthListQueryOptions<T> {
    readonly queryFn: () => Promise<AuthPage<T>>;
    readonly queryKey: ReadonlyArray<unknown>;
    readonly staleTime: number;
}

/**
 * Options for one `{ limit }` window of an admin list. `staleTime` is `0`, not the
 * provider's `Infinity`: this is a one-shot HTTP read, so a remount or a window
 * refocus should re-fetch rather than serve the cached page indefinitely.
 */
const adminAuthListQueryOptions = <T>(list: AdminAuthList<T>, identity: string | null, limit: number): AdminAuthListQueryOptions<T> => {
    return {
        queryFn: () => list.fetchPage(limit),
        queryKey: adminAuthListQueryKey(identity, list, limit),
        staleTime: 0,
    };
};

/**
 * The page to show while a larger window of the same list loads. Only the previous
 * window from the same identity may stand in: another identity's rows must never be
 * shown while its first read is in flight.
 */
const adminAuthListPlaceholder = <T>(
    previous: AuthPage<T> | undefined,
    previousKey: ReadonlyArray<unknown> | undefined,
    queryKey: ReadonlyArray<unknown>,
): AuthPage<T> | undefined => (previousKey !== undefined && previousKey[1] === queryKey[1] ? previous : undefined);

/** The `limit` after a "load more": one page larger, and unchanged past the end of the collection. */
const nextAdminAuthLimit = (current: number, pageSize: number, hasMore: boolean): number => (hasMore ? current + pageSize : current);

/**
 * Mutation options for minting an impersonation session. It deliberately does not call
 * `client.setAuthToken`: swapping the acting client's own token would sign the admin out
 * of their admin session without a visible transition.
 */
const adminAuthImpersonateMutation = (client: LunoraAdminClient): { readonly mutationFn: (userId: string) => Promise<AuthImpersonation> } => {
    return {
        mutationFn: (userId) => client.impersonateAuthUser({ userId }),
    };
};

export type { AdminAuthList, AdminAuthListQueryOptions, AuthUsersListFilter };
export {
    ADMIN_AUTH_DEFAULT_PAGE_SIZE,
    adminAuthImpersonateMutation,
    adminAuthListHasMore,
    adminAuthListPlaceholder,
    adminAuthListQueryKey,
    adminAuthListQueryOptions,
    authOrganizationsList,
    authSessionsList,
    authSignUpInvitationsList,
    authUsersList,
    nextAdminAuthLimit,
    subscribeAdminAuthIdentity,
};
