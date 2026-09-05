"use client";

import type { AuthImpersonation, AuthPage, AuthSession, AuthUser, LunoraClient } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";
import { keepPreviousData, useMutation as useTanStackMutation, useQuery as useTanStackQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { useLunora } from "./lunora-provider";

// ── Prototype: reactive admin/organization auth hooks (plan 237) ──────────
//
// `LunoraClient` carries ~35 imperative auth-admin methods (`listAuthUsers`,
// `createAuthOrganization`, `impersonateAuthUser`, …) hit over `adminFetch` —
// a plain `fetch()` call, entirely separate from the client's WS/live
// transport (`ensureSocket`/`sendOn`/`subscribe`). `@lunora/studio`'s auth
// panels confirm this split explicitly: `useClientQuery` (the studio's
// TanStack-backed HTTP primitive) is documented as having "No live bridge —
// these backends are HTTP-only", contrasted with `useAdminQuery` (reserved
// `__lunora_admin__:*` RPC paths dispatched through the DO, which DO support
// a `live: true` WS subscription). The auth-admin methods below are the
// HTTP-only kind: they cannot ride the live transport at all, so these hooks
// are `@tanstack/react-query`-backed one-shot reads with an explicit
// `refetch`, not `@lunora/react`'s `useQuery` (which requires a
// `FunctionReference` and always opens a live subscription).
//
// See `plans/237-admin-auth-hooks-design.md` for the full evidence trail and
// the hooks-vs-copy-in-console recommendation. This file intentionally does
// NOT reuse the `useClientQuery` name — `@lunora/react` already exports an
// unrelated `useClientQuery` (a local reactive atom over `createClientQuery`,
// no network involved at all).

/** Query-key namespace for every hook in this file — distinct from `@lunora/react`'s live `["lunora", …]` keys and Studio's own `["lunora-admin", …]`/`["lunora-auth-*"]` internal keys, so an app embedding both never collides. */
const ADMIN_AUTH_KEY = "lunora-react-admin-auth";

/** Default page size for the first read; `loadMore` grows the requested window by this amount. */
const DEFAULT_PAGE_SIZE = 50;

/** The shape every list hook in this file returns. */
interface AdminAuthListResult<T> {
    /** Rows loaded so far (the full current window, not just the latest page). `undefined` before the first response. */
    readonly data: ReadonlyArray<T> | undefined;
    /** The read error, or `undefined`. */
    readonly error: Error | undefined;

    /**
     * `true` when the server reports more rows exist beyond the current window
     * (`total > data.length`). `false` before the first response resolves.
     */
    readonly hasMore: boolean;
    /** `true` only before the first response has resolved (matches TanStack's `isLoading`, not `isFetching`). */
    readonly loading: boolean;

    /**
     * Grow the requested window by one page and re-fetch. A no-op while
     * `hasMore` is `false`. This is a growing-window re-fetch (re-request
     * `{ limit }` from the top), not a page-accumulator — `AuthPage` is
     * offset/limit-based, not cursor-based, and there is no live delta stream
     * to keep page boundaries stable against (unlike
     * `@lunora/react`'s `usePaginatedQuery`). See the design doc for the
     * trade-off.
     */
    readonly loadMore: () => void;
    /** Re-run the read — e.g. after a caller performs a mutation via a plain `client.*` call (mirrors Studio's `onDone={refetchOrgs}` pattern). */
    readonly refetch: () => void;
    /** `AuthPage.total` — the server-reported row count across the whole collection, not just the current window. `undefined` before the first response. */
    readonly total: number | undefined;
}

/**
 * Shared list-read primitive: fetch a growing `{ limit }` window through
 * `fetchPage`, expose it as `{ data, total, loading, error, hasMore,
 * loadMore, refetch }`. Effect-free by construction — `loadMore` is a plain
 * state setter in a callback, not a `useEffect` merging page arrivals — so
 * there is nothing here for the "no setState in effect" React gate to flag.
 */
// eslint-disable-next-line func-style -- a generic arrow `<T>(…) =>` is misread as JSX in this package's TSX-mode parser (see use-client-query.ts / studio's use-admin-query.ts for the same workaround).
function useAdminAuthList<T>(
    client: LunoraClient,
    key: QueryKey,
    fetchPage: (limit: number) => Promise<AuthPage<T>>,
    options: { enabled?: boolean; pageSize?: number } = {},
): AdminAuthListResult<T> {
    const { enabled = true, pageSize = DEFAULT_PAGE_SIZE } = options;
    const [limit, setLimit] = useState(pageSize);

    // Fold the acting admin's identity fingerprint into the cache key. Without
    // this, a token swap on the same `LunoraClient` (admin A → admin B via
    // `setAuthToken`, e.g. an admin console that lets one operator switch
    // accounts) would briefly serve admin A's cached rows to admin B under the
    // same collection key, until the `staleTime: 0` refetch resolves —
    // `gcTime` is the provider's default 5min, plenty of time for a stale read
    // to render. `useSyncExternalStore` mirrors `useAuth`'s own token
    // subscription (`use-auth.ts`) so every mounted list hook picks up a swap
    // immediately rather than waiting for an unrelated re-render.
    //
    // The key ingredient is `client.currentIdentity()` — a `subj:`-labelled
    // user id or a non-reversible hash of the token — rather than the raw
    // bearer token itself. Query keys are not private: `LunoraProvider` allows
    // a bring-your-own `QueryClient`, so a token embedded in the key would be
    // serialized into `localStorage` by any app-side `persistQueryClient`
    // persister, rendered verbatim in React Query Devtools, and captured by any
    // telemetry that logs query keys. `currentIdentity()` is the discriminator
    // built for exactly this: it partitions the cache per credential without
    // ever exposing the credential itself, and a same-user token refresh (same
    // `subj:`) keeps the same key instead of forcing a spurious refetch.
    //
    // Residual caveat: `placeholderData: keepPreviousData` below (added for
    // `loadMore`) shows the *previous* observer's data as a placeholder while
    // any new key resolves, including the key produced by an identity swap —
    // so a narrow placeholder-only window (never a persistent cache read) can
    // still surface admin A's rows to admin B until the refetch lands. Scoping
    // the placeholder to same-identity key changes would close that gap; left
    // as a follow-up since this fold already satisfies the ask (an identity
    // swap gets its own cache entry, not admin A's).
    const identity = useSyncExternalStore(
        (onChange) => client.onAuthTokenChange(onChange),
        () => client.currentIdentity(),
        () => client.currentIdentity(),
    );

    const queryKey: QueryKey = [ADMIN_AUTH_KEY, identity ?? "anon", ...key, limit];

    // `fetchPage` is a fresh closure supplied by each caller hook (`useAuthUsers`/`useOrganizations`/`useAuthSessions`) and is not part of the cache identity — `queryKey` (built from the caller's own filter/search/sort args plus `limit` above) already encodes every input that should invalidate the cache. Folding `fetchPage` itself into the key would defeat TanStack's dedup (a fresh closure every render is never `===` the previous one).
    const query = useTanStackQuery<AuthPage<T>>({
        enabled,
        // Keep the previously-resolved page visible (and `isLoading: false`)
        // while a larger `{ limit }` window — a brand-new `queryKey`, since
        // `limit` is part of it — is in flight. Without this, `loadMore()`
        // flashes the whole list to `undefined`/loading on every page grow,
        // because TanStack v5 has no cached entry for the new key yet.
        placeholderData: keepPreviousData,
        queryFn: () => fetchPage(limit),
        queryKey,
        // `<LunoraProvider>`'s default QueryClient sets `staleTime: Infinity`
        // globally (correct for `useQuery`'s WS-owned freshness) — override it
        // here to `0` so a one-shot HTTP-only admin read re-fetches on remount
        // / window refocus instead of serving a stale cached page indefinitely,
        // matching Studio's `useClientQuery` default (`use-admin-query.ts`).
        staleTime: 0,
    });

    const rows = query.data?.rows;
    const total = query.data?.total;
    const hasMore = total !== undefined && rows !== undefined && rows.length < total;

    // No manual `useCallback`: React Compiler (enabled in this package's build
    // — see packem.config.ts) stabilises both closures, matching the rest of
    // this package's hooks (e.g. use-query.ts, use-flag.ts).
    const loadMore = (): void => {
        // No-op past the end (matches the docstring above) — otherwise a
        // caller wired to infinite-scroll keeps growing `limit` past `total`,
        // firing a fresh full-window refetch of the same rows on every call.
        if (hasMore) {
            setLimit((current) => current + pageSize);
        }
    };

    const refetch = (): void => {
        query.refetch().catch(() => undefined);
    };

    return {
        data: rows,
        error: query.error ?? undefined,
        hasMore,
        loadMore,
        loading: query.isLoading,
        refetch,
        total,
    };
}

/** Options shared by every `useAuthUsers`-style hook. */
interface AdminAuthQueryOptions {
    /** Gate the read (rules-of-hooks safe). Defaults to `true`. */
    enabled?: boolean;
    /** Page size for the first read; `loadMore` grows the window by this amount. Defaults to 50. */
    pageSize?: number;
}

/** Options for {@link useAuthUsers}. */
interface UseAuthUsersOptions extends AdminAuthQueryOptions {
    filterField?: string;
    filterValue?: string;
    search?: string;
    searchField?: string;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

/**
 * List authenticated users, paged and optionally searched/filtered/sorted.
 * Hits the admin-gated `GET /_lunora/admin/auth/users` HTTP endpoint via
 * `client.listAuthUsers` (never the WS/live transport) — the worker must be
 * built with an `authAdmin` and `adminToken`.
 *
 * Mirrors `packages/studio/src/features/auth/users-panel.tsx`'s
 * `useClientQuery(["lunora-auth-users", …], () => client.listAuthUsers(…))`
 * read, minus the studio-specific polling (`useAutoRefresh`) — an app using
 * this hook decides its own refresh cadence by calling `refetch()`.
 */
const useAuthUsers = (options: UseAuthUsersOptions = {}): AdminAuthListResult<AuthUser> => {
    const client = useLunora();
    const { enabled, filterField, filterValue, pageSize, search, searchField, sortBy, sortDirection } = options;

    return useAdminAuthList<AuthUser>(
        client,
        // TanStack v5 hashes keys with deterministic, key-sorted JSON, so the
        // options object is the key — no hand-rolled `?? ""`-padded slots to
        // keep in lockstep with the fetch payload below.
        ["users", { filterField, filterValue, search, searchField, sortBy, sortDirection }],
        (limit) => client.listAuthUsers({ filterField, filterValue, limit, search, searchField, sortBy, sortDirection }),
        { enabled, pageSize },
    );
};

/** Options for {@link useOrganizations}. */
type UseOrganizationsOptions = AdminAuthQueryOptions;

/**
 * List organizations (requires the better-auth `organization` plugin).
 * Hits `client.listAuthOrganizations` — an HTTP-only admin-gated read, same
 * transport note as {@link useAuthUsers}.
 *
 * Mirrors `organizations-panel.tsx`'s
 * `useClientQuery(["lunora-auth-orgs"], () => client.listAuthOrganizations({ limit: 100 }))`.
 * Mutations (`client.createAuthOrganization`, `client.deleteAuthOrganization`,
 * …) stay plain `client.*` calls; call this hook's `refetch()` afterward —
 * see the design doc's "mutation ergonomics" section for why no hidden
 * invalidation-on-mutate is wired in.
 */
const useOrganizations = (options: UseOrganizationsOptions = {}): AdminAuthListResult<Record<string, unknown>> => {
    const client = useLunora();
    const { enabled, pageSize } = options;

    return useAdminAuthList<Record<string, unknown>>(client, ["organizations"], (limit) => client.listAuthOrganizations({ limit }), { enabled, pageSize });
};

/** Options for {@link useSignUpInvitations}. */
type UseSignUpInvitationsOptions = AdminAuthQueryOptions;

/**
 * List sign-up invitations (requires the `inviteOnly` plugin). Hits
 * `client.listAuthSignUpInvitations` — an HTTP-only admin-gated read, same
 * transport note as {@link useAuthUsers}.
 *
 * Rows come back unfiltered and newest-first; a row is pending when `acceptedAt`
 * is null and `expiresAt` is in the future. Mutations
 * (`client.createAuthSignUpInvitation`, `client.revokeAuthSignUpInvitation`)
 * stay plain `client.*` calls — call `refetch()` afterward, as the other admin
 * hooks do.
 */
const useSignUpInvitations = (options: UseSignUpInvitationsOptions = {}): AdminAuthListResult<Record<string, unknown>> => {
    const client = useLunora();
    const { enabled, pageSize } = options;

    return useAdminAuthList<Record<string, unknown>>(client, ["sign-up-invitations"], (limit) => client.listAuthSignUpInvitations({ limit }), {
        enabled,
        pageSize,
    });
};

/** Options for {@link useAuthSessions}. */
interface UseAuthSessionsOptions extends AdminAuthQueryOptions {
    /** Scope the list to one user's sessions; omit for the global cross-user browser. */
    userId?: string;
}

/**
 * List auth sessions, paged and optionally scoped to one user. Hits
 * `client.listAuthSessions` — HTTP-only, same transport note as
 * {@link useAuthUsers}.
 *
 * Mirrors `auth-sessions-panel.tsx`'s
 * `useClientQuery(["lunora-auth-sessions", …], () => client.listAuthSessions({ limit }))`.
 * Revoking a session (`client.revokeAuthSession`/`revokeAuthUserSessions`)
 * stays a plain `client.*` call followed by this hook's `refetch()`.
 */
const useAuthSessions = (options: UseAuthSessionsOptions = {}): AdminAuthListResult<AuthSession> => {
    const client = useLunora();
    const { enabled, pageSize, userId } = options;

    return useAdminAuthList<AuthSession>(client, ["sessions", { userId }], (limit) => client.listAuthSessions({ limit, userId }), { enabled, pageSize });
};

/** Everything {@link useImpersonate} returns. */
interface UseImpersonateResult {
    /** The latest successful impersonation's token + user + expiry, or `undefined`. */
    readonly data: AuthImpersonation | undefined;
    /** The latest attempt's error, or `undefined`. */
    readonly error: Error | undefined;

    /**
     * Mint an impersonation session for `userId`, resolving its bearer
     * `AuthImpersonation`. Deliberately does **not** call
     * `client.setAuthToken(...)` on the current client — see the security
     * note below.
     */
    readonly impersonate: (userId: string) => Promise<AuthImpersonation>;
    /** `true` while an impersonation request is in flight. */
    readonly pending: boolean;
    /** Clear `data`/`error` back to idle. */
    readonly reset: () => void;
}

/**
 * Mint an impersonation session via `client.impersonateAuthUser` — the one
 * genuinely mutation-shaped hook of the four prototyped here (TanStack
 * `useMutation` underneath, matching `@lunora/react`'s own `useMutation`
 * ergonomics: `data`/`error`/`pending`/`reset`).
 *
 * **Security note (open question — see the design doc):** Studio's
 * `user-detail-drawer.tsx` (`onImpersonate`) mints the token and displays it
 * in a read-only text field; it never calls `client.setAuthToken(token)` on
 * the admin's own client instance. This hook preserves that discipline
 * deliberately — silently swapping the *current* session would sign the
 * admin out of their own admin session with no visible transition and no
 * "return to admin" path. The caller decides what to do with the resolved
 * `AuthImpersonation` (open a second tab/incognito window authenticated as
 * the target user, surface it for manual copy, etc.). What the ideal UX is
 * (a dedicated "Acting as X — Return to admin" banner + explicit swap-back)
 * is an open product question this spike does not resolve.
 *
 * Unlike the three list hooks, impersonating a user has no single paired
 * list to invalidate (it may affect a sessions list, but not the user/org
 * list currently being viewed) — mirroring Studio's own `refresh: false` on
 * this action, this hook does not auto-invalidate anything. A caller that
 * also renders `useAuthSessions` can call its `refetch()` explicitly.
 */
const useImpersonate = (): UseImpersonateResult => {
    const client = useLunora();

    const mutation = useTanStackMutation<AuthImpersonation, Error, string>({
        mutationFn: (userId: string) => client.impersonateAuthUser({ userId }),
        // No `onSuccess` invalidation here — see the docstring above.
    });

    const { mutateAsync, reset } = mutation;

    const impersonate = (userId: string): Promise<AuthImpersonation> => mutateAsync(userId);

    return {
        data: mutation.data,
        error: mutation.error ?? undefined,
        impersonate,
        pending: mutation.isPending,
        reset,
    };
};

export type { AdminAuthListResult, UseAuthSessionsOptions, UseAuthUsersOptions, UseImpersonateResult, UseOrganizationsOptions, UseSignUpInvitationsOptions };
export { useAuthSessions, useAuthUsers, useImpersonate, useOrganizations, useSignUpInvitations };
