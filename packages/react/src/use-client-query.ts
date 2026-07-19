"use client";

import type { ClientQueryRef, Unsubscribe } from "@lunora/client";
import { useCallback, useSyncExternalStore } from "react";

import { useLunora } from "./lunora-provider";

type Setter<T> = (value: T) => void;

/**
 * Subscribe to a local-only {@link ClientQueryRef} and re-render when its
 * value changes. Unlike `useQuery`, this never touches the network — the
 * value lives in a reactive store on the `LunoraClient` instance and is shared
 * across every consumer of the same ref.
 *
 * The initial render reads the store synchronously (via
 * `useSyncExternalStore`), so there is never an "undefined flash" — the value
 * is either the one most recently set or `ref.defaultValue`.
 *
 * Returns a `[value, setter]` tuple, matching the `useState` convention.
 * @example
 * ```tsx
 * import { useClientQuery, createClientQuery } from "@lunora/react";
 *
 * const sidebarOpen = createClientQuery("sidebarOpen", true);
 *
 * function Sidebar() {
 *   const [open, setOpen] = useClientQuery(sidebarOpen);
 *   return <aside data-open={open}>…</aside>;
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-constraint -- `extends unknown` is load-bearing: it disambiguates this generic arrow from a JSX tag under the package's TSX-mode parser (bare `<T>` makes the build's babel read `<T>(…)` as JSX and throws). A bare `<T,>` trailing comma gets stripped by Prettier in a `.ts` file, so the constraint is the stable form.
const useClientQuery = <T extends unknown>(ref: ClientQueryRef<T>): [T, Setter<T>] => {
    const client = useLunora();

    // Stable across renders (keyed on the ref's semantic identity, `ref.key`, not
    // just `ref` object identity) so `useSyncExternalStore` doesn't tear down and
    // re-open the store subscription on every render — an inline arrow here would
    // churn the subscription every render, amplifying re-render storms in lists.
    const subscribe = useCallback(
        (onStoreChange: () => void): Unsubscribe =>
            client.subscribeClientQuery(ref, () => {
                onStoreChange();
            }),
        [client, ref.key],
    );

    const value = useSyncExternalStore(
        subscribe,
        () => client.getClientQuery(ref),
        () => client.getClientQuery(ref),
    );

    const setter = useCallback<Setter<T>>(
        (next: T) => {
            client.setClientQuery(ref, next);
        },
        [client, ref],
    );

    return [value, setter];
};

export default useClientQuery;
