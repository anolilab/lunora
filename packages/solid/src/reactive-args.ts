import { stableWireKey } from "@lunora/wire";
import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";

import type { Disposer } from "./solid-compat";
import { trackedEffect } from "./solid-compat";

/**
 * Bind a maybe-reactive args source to a live subscription, re-opening only when
 * the args' **content** changes.
 *
 * The tracked source is a `createMemo` over `stableWireKey(resolveArgs())`, not
 * the args object: an accessor such as
 * `() => ({ id: id(), limit: Math.min(limit(), 10) })` produces a fresh object
 * every time any dependency ticks, and keying on identity would tear the live
 * subscription down and re-snapshot from the server — blanking the rendered
 * value — for args that did not actually change.
 *
 * The memo is load-bearing, not a cache: `createEffect` re-runs whenever a
 * tracked *signal* changes, not when the tracked *expression's value* changes,
 * so a bare `() => stableWireKey(...)` source would still re-run the body on
 * every tick. A memo only notifies its observers when the key itself differs.
 * The dedupe also cannot live inside `apply`: by then the previous generation's
 * disposer has already run.
 *
 * `apply` receives the exact value the key was built from, not a second read of
 * `resolveArgs()`: an accessor that is not a pure function of its signals
 * (`Date.now()`, a mutable ref) would otherwise open the subscription with args
 * the key never described, and a later tick back to the keyed value would not
 * restart it. It returns the teardown for what it opened, exactly as
 * {@link trackedEffect} expects. This is Solid's counterpart to
 * `@lunora/svelte`'s `subscribeReactiveArgs` and `@lunora/angular`'s
 * `attachReactiveArgs`.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so it composes with the other named imports at its call sites; a default would not.
export const trackedArgsEffect = <T>(resolveArgs: Accessor<T>, apply: (value: T) => Disposer): void => {
    // `createEffect` is inert during SSR, so the accessor was never read there; the
    // memo below runs eagerly on the server and would call an accessor such as
    // `() => ({ path: window.location.pathname })` that only works in a browser.
    // Stay idle until the client takes over. `solid-js/web`'s `isServer` is not
    // importable from both majors, so probe for the browser global instead.
    if ((globalThis as { window?: unknown }).window === undefined) {
        return;
    }

    let resolved: T;
    const argsKey = createMemo(() => {
        resolved = resolveArgs();

        return stableWireKey(resolved);
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the memo runs before its effect, so `resolved` is always assigned by then.
    trackedEffect(argsKey, () => apply(resolved!));
};
