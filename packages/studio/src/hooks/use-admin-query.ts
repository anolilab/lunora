import { useLunora } from "@lunora/react";
import type { QueryKey } from "@tanstack/react-query";
import { keepPreviousData as keepPreviousDataPlaceholder, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { adminRef, callOptions, errorMessage, fireAndForget } from "../lib/internal";
import { operationLog } from "../lib/operation-log";

/**
 * The TanStack Query key for a reserved admin RPC read. Stable + structural:
 * TanStack hashes the key deeply, so an args object built in a different field
 * order still dedupes to the same cache entry. Every studio admin read shares
 * this shape so the same `(path, args, shard)` is fetched once and reused across
 * panels (e.g. `listTables` / `maskPolicies` / `advisories` mounted in several
 * places resolve to one in-flight request + one cache entry).
 */
const adminQueryKey = (path: string, args: Record<string, unknown>, shardKey: string): QueryKey => ["lunora-admin", path, args, shardKey.trim()];

/**
 * Append the identity of the client a result was fetched with.
 *
 * Every read here fetches THROUGH the client, so the credentials it carries are
 * a query input and belong in the key. They change at runtime: the studio shell
 * rebuilds the `LunoraClient` whenever the admin token changes (a `useMemo` on
 * the debounced token in `app/app.tsx`) and `LunoraProvider` is not keyed, so the
 * subtree never remounts — while `LunoraProvider` builds its `QueryClient` once
 * per mount with `useState`, so the cache outlives the swap. Without this, fixing
 * a bad admin token left every panel serving the results the *previous*,
 * unauthorized client fetched: 403s and empty tables that only a reload cleared.
 *
 * Appended LAST so it never disturbs prefix matching — `useInvalidateAdmin`
 * deliberately builds the unscoped key, which then matches every client's
 * entries for that path (invalidating a write's effects regardless of which
 * client cached them).
 */
const clientScopedKey = (queryKey: QueryKey, clientId: string): QueryKey => [...queryKey, clientId];

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
    /** The raw thrown value (a `LunoraClientError` carries `hint`/`docsUrl`), or `undefined`. Lets a panel render the actionable fix via the `ErrorAlert` component. */
    readonly errorSource: unknown;
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

// ── Dev request-loop detector ───────────────────────────────────────────────
// A render/effect loop that re-issues the same read can storm the network until
// the tab locks up — and nothing throws, the requests just pile up (the studio
// hit exactly this against a cold/cross-origin worker). Count queryFn
// invocations per key in a rolling 1s window and scream ONCE, with the offending
// key + a stack, when a single key fires improbably often. Browser-console only;
// the server-side counterpart is the `LUNORA_DEBUG_RPC` log in `@lunora/runtime`'s
// RPC handler (visible in the dev terminal).
//
// The window counts fetches, not components, and the bucket is module-level with
// no reset — so it cannot tell "one component re-issuing 25 times" from "25
// components mounting". In a browser that distinction is academic (nobody opens
// a page 25 times a second), which is why the heuristic is good enough there and
// why the gate below excludes `test`: a suite that mounts a panel once per case
// trips this constantly, and a diagnostic that cries wolf teaches people to
// ignore the one time it is right.
//
// An earlier version of this comment claimed 25×/s "is never legitimate, because
// TanStack dedupes identical in-flight reads". Dedupe only covers reads that
// overlap; sequential mounts each awaited to completion never do, which is
// exactly the case a test suite produces.
const RPC_LOOP_WINDOW_MS = 1000;
const RPC_LOOP_THRESHOLD = 25;
const rpcCallTimes = new Map<string, number[]>();

// The detector is a DEV-ONLY aid: it adds a `JSON.stringify` + `Map` write on
// every query and retains a bucket per unique key for the tab's lifetime — fine
// while debugging, but needless overhead (and a slow leak) in a shipped app, and
// pure noise under a test runner (see above).
// Gate on `process.env.NODE_ENV` — the React-ecosystem convention every bundler
// inlines (Vite, packem `--development`/`--production`) — so a production build
// dead-code-eliminates the wrapper and queries call `queryFunction` directly.
const isDevelopment = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

const noteQueryFetch = (key: string): void => {
    const now = Date.now();
    const recent = (rpcCallTimes.get(key) ?? []).filter((time) => now - time < RPC_LOOP_WINDOW_MS);

    recent.push(now);
    rpcCallTimes.set(key, recent);

    if (recent.length === RPC_LOOP_THRESHOLD) {
        /* eslint-disable no-console -- intentional dev diagnostic naming a runaway-request loop + its call site */
        console.error(
            `[lunora-studio] possible request loop: ${key} fired ${String(RPC_LOOP_THRESHOLD)}× in <1s — a render/effect is re-issuing this read unbounded.`,
        );
        console.trace("[lunora-studio] request-loop call site");
        /* eslint-enable no-console */
    }
};

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
    const client = useLunora();
    const { enabled = true, keepPreviousData = false, staleTime = 0 } = options;

    // Scoped here rather than in each caller's key literal: this is the one place
    // every studio read passes through, so callers keep writing plain keys
    // (`["lunora-auth-config"]`) and still get credential-correct caching.
    const scopedKey = clientScopedKey(queryKey, client.clientIdentifier());

    // Outside dev, call the caller's fetch directly — no diagnostic overhead. In
    // dev, wrap it with the request-loop counter. Either way it's a plain
    // reference (not an inline literal) so it stays opaque to the query-key
    // exhaustive-deps lint — the caller already encodes the real inputs in
    // `queryKey`; `queryFunction` is derived from them and intentionally not part
    // of the key.
    const trackedQueryFunction = isDevelopment
        ? (): Promise<T> => {
              noteQueryFetch(JSON.stringify(queryKey));

              return queryFunction();
          }
        : queryFunction;

    const query = useQuery<T>({
        enabled,
        queryFn: trackedQueryFunction,
        placeholderData: keepPreviousData ? keepPreviousDataPlaceholder : undefined,
        queryKey: scopedKey,
        staleTime,
    });

    return {
        data: query.data,
        error: query.error ? errorMessage(query.error) : query.error,
        errorSource: query.error ?? undefined,
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
 * server's `LUNORA_ADMIN_TOKEN` (sent as the client's bearer; the WS leg rides
 * the client's `wsToken` provider, which mints a short-lived sub-token so the
 * master credential never appears in the socket URL); this hook
 * issues no credentials of its own. The `QueryClient` it uses is the one
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
    // No recording wrapper here: the client itself is wrapped once where the
    // studio mounts it (`lib/recording-client.ts`), so every dispatch — this one
    // and the ~50 imperative call sites alike — lands on the tape by construction.
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

        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- opens the live subscription channel — synchronising with an external system is the effect's purpose
        setLiveError(undefined);

        // One tape entry per CHANNEL: opened here, counted on each push, closed
        // in the teardown below (see `operation-log.ts`).
        const seq = operationLog.startSubscription(path, args, shardKey);

        const unsubscribe = client.subscribe(
            adminRef(path),
            args,
            (value) => {
                operationLog.recordPush(seq);
                setLiveError(undefined);
                // Must be the SAME key `useClientQuery` reads from, or pushes land
                // in a cache entry nothing renders and live mode silently stops.
                queryClient.setQueryData(clientScopedKey(queryKey, client.clientIdentifier()), value);
            },
            {
                ...callOptions(shardKey),
                onError: (error) => {
                    operationLog.failSubscription(seq, error.message);
                    setLiveError(error.message);
                },
            },
        );

        return () => {
            operationLog.endSubscription(seq);
            unsubscribe();
        };
        // `args`/`path`/`shardKey`/`queryKey` are all tracked via `keySignature`;
        // `queryClient` IS provider-stable (`LunoraProvider` builds it once per
        // mount with `useState`). `client` is NOT — the studio shell rebuilds the
        // `LunoraClient` whenever the admin token changes (a `useMemo` on the
        // debounced token in `app/app.tsx`) and closes the old one, without
        // remounting, so it must re-subscribe: see `clientScopedKey` above, which
        // exists for the read leg of the same swap. Omitting it left the live
        // bridge bound to the closed client for the life of the mount — the panel
        // re-fetched and looked fixed while it had silently stopped streaming.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, keySignature, enabled, live]);

    // When the read is gated off or live mode is disabled the subscription effect
    // returns early without re-running, so a `liveError` captured from a previous
    // `live` window would otherwise linger. Suppress it whenever the live bridge
    // isn't actually active.
    return { ...base, liveError: enabled && live ? liveError : undefined };
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
