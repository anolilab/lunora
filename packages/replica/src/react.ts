import { useSyncExternalStore } from "react";

import type { LocalMirror, LocalQueryResult } from "./local-mirror";

/**
 * Options for the {@link useLocalQuery} hook.
 * @experimental
 */
export interface UseLocalQueryOptions {
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
 * React hook that subscribes to a local SQLite query and returns
 * live-updating results whenever the mirror applies a diff.
 *
 * Uses `useSyncExternalStore`, with `getSnapshot` reading through
 * {@link LocalMirror.queryCached} — the render body itself never touches
 * SQLite. `queryCached` returns the SAME cached result object for the same
 * `(mirror.version, sql, params)` triple, so a re-render that isn't
 * preceded by an `applyDiff`/`clearData` (e.g. a parent re-rendering for an
 * unrelated reason) is a cache hit, not a fresh query — and because
 * `getSnapshot` is what `useSyncExternalStore` itself calls to detect
 * changes, the result can't tear under concurrent rendering the way an
 * imperative `mirror.query(...)` call after the hook (decoupled from
 * React's snapshot mechanism) could.
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
export const useLocalQuery = <T = Record<string, unknown>>(
    mirror: LocalMirror,
    sql: string,
    params?: ReadonlyArray<unknown>,
    _options?: UseLocalQueryOptions,
): LocalQueryResult<T> => {
    const subscribe = (onStoreChange: () => void): (() => void) => mirror.onChange(onStoreChange);

    // Reads through the mirror's per-version query cache — a pure,
    // side-effect-free lookup on a cache hit (i.e. on every render that
    // isn't preceded by a mutation), and the ONLY place SQLite is actually
    // queried on a cache miss (a real `applyDiff`/`clearData`, or the very
    // first render).
    const getSnapshot = (): LocalQueryResult<T> => mirror.queryCached<T>(sql, params);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
