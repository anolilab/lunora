import type { Readable, Unsubscriber } from "svelte/store";

import { isReadableStore } from "./is-readable-store";

/**
 * Bind a maybe-reactive args source to a live subscription, and own the
 * ordering the three query primitives (`query`, `subscription`,
 * `paginatedQuery`) all depend on.
 *
 * A static value opens exactly once. A `Readable` source opens on every
 * emission, tearing the previous subscription down **before** opening the
 * next — so an emission that resolves to nothing (the `"skip"` sentinel, whose
 * `open` returns a no-op teardown) cannot leak the subscription it replaced.
 * The returned stop function detaches the args source and tears down whatever
 * is currently open.
 *
 * `open` returns the teardown for the subscription it opened; anything a fresh
 * emission must reset (a stale error, pagination state) belongs in that
 * teardown or at the top of `open`, so each emission starts from a clean slate.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so it composes with the other named imports at its call sites; a default would not.
export const subscribeReactiveArgs = <T>(args: T | Readable<T>, open: (value: T) => Unsubscriber): Unsubscriber => {
    if (!isReadableStore(args)) {
        return open(args);
    }

    let teardown: Unsubscriber = () => {};

    const unsubscribeArgs = args.subscribe((resolved) => {
        teardown();
        teardown = open(resolved);
    });

    return () => {
        unsubscribeArgs();
        teardown();
    };
};
