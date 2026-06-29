import { useLunora } from "@lunora/react";
import type { QueryKey } from "@tanstack/react-query";
import { keepPreviousData as keepPreviousDataPlaceholder, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { adminRef, callOptions, errorMessage, fireAndForget } from "../lib/internal";

/**
 * The TanStack Query key for a reserved admin RPC read. Stable + structural:
 * TanStack hashes the key deeply, so an args object built in a different field
 * order still dedupes to the same cache entry. Every studio admin read shares
 * this shape so the same `(path, args, shard)` is fetched once and reused across
 * panels (e.g. `listTables` / `maskPolicies` / `advisories` mounted in several
 * places resolve to one in-flight request + one cache entry).
 */
const adminQueryKey = (path: string, args: Record<string, unknown>, shardKey: string): QueryKey => ["lunora-admin", path, args, shardKey];

/** Options for {@link useAdminQuery}. */
interface UseAdminQueryOptions {
    /**
     * Gate the read behind a condition (rules-of-hooks safe). When `false` no
     * request is made and no subscription is opened; `data` stays whatever the
     * cache last held (or `undefined`). Defaults to `true`.
     */
    readonly enabled?: boolean;

    /**
     * Keep the previously-resolved data visible while a new key (a different
     * shard / page / filter) is being fetched, instead of flashing back to
     * `undefined`. Mirrors the data browser's old "show the last page until the
     * next lands" behavior. Defaults to `false`.
     */
    readonly keepPreviousData?: boolean;

    /**
     * Open a live admin subscription (`client.subscribe`) for this exact key and
     * push every server re-run into the query cache, so the panel streams writes
     * with no manual Refresh — the same model as `@lunora/react`'s `useQuery`. A
     * rejected subscription (e.g. the client carries no admin `wsToken`) surfaces
     * as {@link AdminQueryResult.liveError}; the one-shot fetch still seeded the
     * data, so it stays visible. Defaults to `false` (one-shot read).
     */
    readonly live?: boolean;

    /**
     * Shard the read targets. Empty string → the root shard. Part of the cache
     * key, so changing it transparently re-fetches (and re-subscribes when
     * `live`).
     */
    readonly shardKey?: string;

    /**
     * Override how long a resolved value is considered fresh. Defaults to
     * `Infinity` for a `live` query (the WS owns freshness once seeded) and `0`
     * for a one-shot read (so it re-fetches on remount / window refocus, matching
     * the old visibility-driven refresh).
     */
    readonly staleTime?: number;
}

/** Everything {@link useAdminQuery} returns. A thin, panel-friendly view over the TanStack result. */
interface AdminQueryResult<T> {
    /** The latest resolved value, or `undefined` before the first response. */
    readonly data: T | undefined;
    /** The read error message, or `null`. Normalised from the thrown value. */
    readonly error: null | string;
    /** `true` only on the very first load (no cached data yet). */
    readonly isLoading: boolean;

    /**
     * A rejected live subscription's message, or `undefined`. Only meaningful
     * when `live` is set; the one-shot data stays valid, it just stops updating.
     */
    readonly liveError: string | undefined;
    /** Imperatively re-run the one-shot read (e.g. a manual Refresh button). */
    readonly refetch: () => void;
}

/** Options for {@link useClientQuery}. */
interface UseClientQueryOptions {
    /** Gate the read (rules-of-hooks safe). Defaults to `true`. */
    readonly enabled?: boolean;
    /** Keep the previously-resolved data visible while a new key is fetched. Defaults to `false`. */
    readonly keepPreviousData?: boolean;
    /** Freshness window; defaults to `0` (re-fetch on remount / refocus). */
    readonly staleTime?: number;
}

/**
 * Read through TanStack Query with a caller-supplied `queryFn` — the base
 * primitive for the studio's non-admin-RPC reads (the bespoke
 * `client.listAuthUsers()` / `client.schedulerStatus()` / … methods that aren't
 * routed as `__lunora_admin__:*` paths). The caller owns the `queryKey` (must be
 * structurally stable) and the fetch; this hook adds the cache, dedup, and the
 * uniform `{ data, error, isLoading, refetch }` surface. No live bridge — these
 * backends are HTTP-only and the panels poll via `useAutoRefresh`.
 *
 * {@link useAdminQuery} builds on this for admin-RPC reads (it supplies the
 * `["lunora-admin", …]` key + `client.query` fetch and layers a live WS
 * subscription on top).
 */
// eslint-disable-next-line func-style -- a generic arrow `<T>(…) =>` is misread as a JSX element by packem's Babel (`.ts` compiled with the React preset); a function declaration is the unambiguous form.
function useClientQuery<T>(queryKey: QueryKey, queryFunction: () => Promise<T>, options: UseClientQueryOptions = {}): AdminQueryResult<T> {
    const { enabled = true, keepPreviousData = false, staleTime = 0 } = options;

    const query = useQuery<T>({
        enabled,
        queryFn: queryFunction,
        placeholderData: keepPreviousData ? keepPreviousDataPlaceholder : undefined,
        queryKey,
        staleTime,
    });

    return {
        data: query.data,
        error: query.error ? errorMessage(query.error) : query.error,
        isLoading: query.isLoading,
        liveError: undefined,
        refetch: (): void => {
            fireAndForget(query.refetch());
        },
    };
}

/**
 * Read a reserved admin RPC through TanStack Query — the studio's single data
 * primitive, replacing the per-panel `useState` + `useEffect` + `try/catch`
 * fetch (whose unstable-dependency footgun caused the studio's render-loop bug)
 * and the former hand-rolled live-admin subscription hook.
 *
 * The admin RPCs are intercepted inside the Durable Object and gated by the
 * server's `LUNORA_ADMIN_TOKEN` (sent as the client's bearer / `wsToken`); this
 * hook issues no credentials of its own. The `QueryClient` it uses is the one
 * `@lunora/react`'s `LunoraProvider` already mounts above the studio.
 *
 * With `live`, it additionally opens one shared WS subscription for the key and
 * pushes each push into the cache, so the data streams — identical to the
 * model `@lunora/react`'s `useQuery` uses for user-facing functions.
 */
// eslint-disable-next-line func-style -- a generic arrow `<T>(…) =>` is misread as a JSX element by packem's Babel (`.ts` compiled with the React preset); a function declaration is the unambiguous form.
function useAdminQuery<T>(path: string, args: Record<string, unknown>, options: UseAdminQueryOptions = {}): AdminQueryResult<T> {
    const client = useLunora();
    const queryClient = useQueryClient();

    const { enabled = true, keepPreviousData = false, live = false, shardKey = "", staleTime } = options;

    const queryKey = adminQueryKey(path, args, shardKey);

    // The base read shares the generic client-query machinery (cache, dedup, error
    // normalisation, refetch); admin layers a live WS subscription on top.
    const base = useClientQuery<T>(queryKey, () => client.query(adminRef(path), args, callOptions(shardKey)) as Promise<T>, {
        enabled,
        keepPreviousData,
        staleTime: staleTime ?? (live ? Number.POSITIVE_INFINITY : 0),
    });

    const [liveError, setLiveError] = useState<string | undefined>(undefined);

    // Serialise the key for the effect dependency so an equal-but-new args object
    // doesn't tear down and re-open the subscription each render; the subscribe
    // call still passes the live `args`/`shardKey` (not a JSON round-trip).
    const keySignature = JSON.stringify(queryKey);

    useEffect(() => {
        if (!enabled || !live) {
            return undefined;
        }

        setLiveError(undefined);

        return client.subscribe(
            adminRef(path),
            args,
            (value) => {
                setLiveError(undefined);
                queryClient.setQueryData(queryKey, value);
            },
            {
                ...callOptions(shardKey),
                onError: (error) => {
                    setLiveError(error.message);
                },
            },
        );
        // `args`/`queryKey` are tracked via `keySignature`; `client`/`queryClient` are provider-stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keySignature, enabled, live]);

    return { ...base, liveError };
}

/**
 * A stable callback that invalidates one or more admin reads so they re-fetch —
 * the post-write refresh primitive (replacing the old "await fetchPage again"
 * dance). Pass the same `(path, args, shard)` the read used; omit `args`/`shard`
 * to invalidate every cached variant of a path (e.g. all shards of a table).
 */
const useInvalidateAdmin = (): ((path: string, args?: Record<string, unknown>, shardKey?: string) => void) => {
    const queryClient = useQueryClient();

    return (path: string, args?: Record<string, unknown>, shardKey?: string): void => {
        const queryKey = args === undefined ? ["lunora-admin", path] : adminQueryKey(path, args, shardKey ?? "");

        fireAndForget(queryClient.invalidateQueries({ queryKey }));
    };
};

export { adminQueryKey, useAdminQuery, useClientQuery, useInvalidateAdmin };
export type { AdminQueryResult, UseAdminQueryOptions, UseClientQueryOptions };
