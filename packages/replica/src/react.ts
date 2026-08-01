import { useMemo, useSyncExternalStore } from "react";

import type { LocalMirror } from "./local-mirror";

/**
 * Result of {@link useLocalQuery} — a discriminated union so callers get a
 * typed error instead of a swallowed `undefined`.
 * @experimental
 */
// eslint-disable-next-line sonarjs/no-redundant-optional -- `?: undefined` is the discriminant, not a redundant optional: it's what lets `result.data !== undefined` narrow the union without an explicit `"data" in result` check. Dropping either half breaks that narrowing.
type LocalQueryResult<T> = { readonly data: T[]; readonly error?: undefined } | { readonly data?: undefined; readonly error: Error };

/**
 * Options for the {@link useLocalQuery} hook.
 * @experimental
 */
interface UseLocalQueryOptions {
    /**
     * Optional shard key (reserved for future use; currently unused).
     *
     * Intended for multi-mirror setups where a single app maintains multiple
     * SQLite databases sharded by a key (e.g. user id, tenant id). Currently
     * has no effect — the hook always queries the mirror passed as the first
     * argument.
     */
    shardKey?: string;
}

/**
 * Serialize `params` into a stable, `useMemo`-safe dependency key.
 *
 * Plain `JSON.stringify` throws `TypeError: Do not know how to serialize a
 * BigInt` for a `bigint` param — and `bigint` is a normal bind value here
 * (64-bit SQLite ids, `normalizeBindValue` in `diff-applier.ts` supports
 * bigint binds). That throw would happen synchronously during render (inside
 * the `useMemo` factory), crashing the component subtree instead of
 * surfacing as a query `{ error }`. The replacer stringifies bigints as
 * their decimal digits followed by a trailing `n` so the key stays a plain
 * string for any param shape.
 */
const stableParamsKey = (params?: ReadonlyArray<unknown>): string =>
    JSON.stringify(params ?? [], (_key, value: unknown) => (typeof value === "bigint" ? `${value.toString()}n` : value));

/**
 * React hook that subscribes to a local SQLite query and returns
 * live-updating results whenever the mirror applies a diff.
 *
 * Uses `useSyncExternalStore` with `getSnapshot` reading {@link LocalMirror.version}
 * — a plain number, unconditionally `Object.is`-stable across calls with no
 * mutation in between. The actual query runs in a `useMemo` keyed on
 * `[mirror, version, sql, stableParamsKey(params)]`, so it only re-executes
 * when the mirror actually advances (or `sql`/`params` change) — not on
 * every unrelated re-render.
 *
 * This intentionally does NOT cache query results inside {@link LocalMirror}
 * itself: an LRU-capped cache in the mirror core evicts still-mounted hooks'
 * entries once more than the cap's worth of distinct live queries are open
 * on one mirror, which makes `getSnapshot` return a fresh (non-identical)
 * object on the next read — `useSyncExternalStore` then force-re-renders,
 * re-inserts, evicts another entry, and so on without bound. Keying the
 * external-store snapshot on the version primitive instead of a cached
 * query result has no such cap, so it can't loop.
 *
 * The hook works with React 18+ concurrent features, Suspense, and
 * server-side rendering. During SSR the same value is returned as on
 * the client (the mirror's current state at render time).
 * @param mirror The {@link LocalMirror} instance to query. Must have been
 * constructed with an {@link import("./adapters/types").SqliteAdapter}.
 * @param sql Parameterised SQL query string. Use `?` placeholders for
 * bound parameters (the adapter forwards them to the underlying SQLite
 * engine without rewriting).
 * @param params Optional positional bound parameters matching `?`
 * placeholders in `sql`.
 * @param _options Optional configuration (currently unused; reserved for
 * future features like shard key routing).
 * @returns `{ data }` with the result rows typed via the generic parameter
 * `T`, or `{ error }` when the query fails (e.g. malformed SQL, or the
 * target table doesn't exist yet because no matching diff has been applied
 * — that specific case surfaces as a "no such table" `Error`). Never
 * collapses a failure to `undefined` — check `error` explicitly rather than
 * treating a missing `data` as "still loading".
 * @example
 * ```tsx
 * import { useLocalQuery } from "@lunora/replica/react";
 * import { mirror } from "./mirror";
 *
 * function UserList() {
 *   const { data: users, error } = useLocalQuery<{ id: string; name: string }>(
 *     mirror,
 *     "SELECT id, name FROM fn_todos_list WHERE name LIKE ?",
 *     ["%alice%"],
 *   );
 *
 *   if (error) {
 *     return <p>Query failed: {error.message}</p>;
 *   }
 *
 *   if (users === undefined) {
 *     return <p>Waiting for data…</p>;
 *   }
 *
 *   return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
 * }
 * ```
 * @experimental
 */
const useLocalQuery = <T = Record<string, unknown>>(
    mirror: LocalMirror,
    sql: string,
    params?: ReadonlyArray<unknown>,
    _options?: UseLocalQueryOptions,
): LocalQueryResult<T> => {
    const subscribe = (onStoreChange: () => void): (() => void) => mirror.onChange(onStoreChange);

    // `mirror.version` is a plain number — unconditionally `Object.is`-stable
    // across calls with no intervening `applyDiff`/`clearData`. No cap, no
    // eviction, so it can never make `useSyncExternalStore` see a spurious
    // change.
    const getSnapshot = (): number => mirror.version;

    const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const paramsKey = stableParamsKey(params);

    return useMemo<LocalQueryResult<T>>(() => {
        try {
            return { data: mirror.query<T>(sql, params) };
        } catch (error) {
            return { error: error instanceof Error ? error : new Error(String(error)) };
        }
    }, [mirror, version, sql, paramsKey]);
};

export { useLocalQuery };
export type { LocalQueryResult, UseLocalQueryOptions };
