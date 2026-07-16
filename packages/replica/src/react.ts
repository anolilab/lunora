import { useSyncExternalStore } from "react";

import type { LocalMirror } from "./local-mirror";

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
 * Uses `useSyncExternalStore` to subscribe to the mirror's `onChange`
 * callback — every diff triggers a re-query against the local SQLite.
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
 * @returns An array of result rows typed via the generic parameter `T`, or
 * `undefined` if the query fails (e.g. the target table doesn't exist yet
 * because no matching diff has been applied). Treat `undefined` as a
 * "loading" or "no data yet" signal in your component.
 *
 * **Error handling**: The hook catches SQL errors internally and returns
 * `undefined`. Use a try-catch around `mirror.query(...)` directly if you
 * need finer-grained error diagnostics.
 * @example
 * ```tsx
 * import { useLocalQuery } from "@lunora/replica/react";
 * import { mirror } from "./mirror";
 *
 * function UserList() {
 *   const users = useLocalQuery<{ id: string; name: string }>(
 *     mirror,
 *     "SELECT id, name FROM fn_todos_list WHERE name LIKE ?",
 *     ["%alice%"],
 *   );
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
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public `<T>` row-type generic kept for caller ergonomics (specifies the returned row shape, like `useState<T>`)
export const useLocalQuery = <T = Record<string, unknown>>(
    mirror: LocalMirror,
    sql: string,
    params?: ReadonlyArray<unknown>,
    _options?: UseLocalQueryOptions,
): T[] | undefined => {
    const subscribe = (onStoreChange: () => void): (() => void) => mirror.onChange(onStoreChange);

    const getSnapshot = (): number => mirror.eventLog.size;
    const getServerSnapshot = (): number => mirror.eventLog.size;

    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    try {
        return mirror.query<T>(sql, params);
    } catch {
        return undefined;
    }
};
