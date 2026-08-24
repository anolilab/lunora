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
 *
 * Emissions are serialized. A source that emits *during* `open` — svelte/store's
 * own queue rules that out, but the `Readable` contract is duck-typed and a
 * hand-rolled store has no such queue — would otherwise open a subscription whose
 * teardown the outer call then overwrites, leaking it. Such a value waits and is
 * applied once the in-flight `open` has handed over its teardown, so the last
 * emission always wins and every subscription it replaced is closed.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so it composes with the other named imports at its call sites; a default would not.
export const subscribeReactiveArgs = <T>(args: T | Readable<T>, open: (value: T) => Unsubscriber): Unsubscriber => {
    if (!isReadableStore(args)) {
        return open(args);
    }

    let teardown: Unsubscriber = () => {};
    let opening = false;
    // A one-slot queue, not a value: `T` itself may legitimately be undefined.
    let queued: [T] | undefined;

    const unsubscribeArgs = args.subscribe((resolved) => {
        if (opening) {
            // Re-entrant emission: `open` below has not returned its teardown yet,
            // and the assignment that follows it would overwrite anything we stored
            // here — leaking the subscription this emission opened. Hand the value
            // to the loop that owns the teardown instead.
            queued = [resolved];

            return;
        }

        opening = true;

        try {
            let next: [T] | undefined = [resolved];

            while (next) {
                teardown();
                teardown = open(next[0]);
                next = queued;
                queued = undefined;
            }
        } finally {
            opening = false;
        }
    });

    return () => {
        unsubscribeArgs();
        teardown();
    };
};
