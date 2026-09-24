import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";

import { stableWireKey } from "../../../shared/wire-key";
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
 * `apply` runs in the (untracked) apply phase, so re-reading `resolveArgs()`
 * there registers no dependency; it returns the teardown for what it opened,
 * exactly as {@link trackedEffect} expects. This is Solid's counterpart to
 * `@lunora/svelte`'s `subscribeReactiveArgs` and `@lunora/angular`'s
 * `attachReactiveArgs`.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so it composes with the other named imports at its call sites; a default would not.
export const trackedArgsEffect = <T>(resolveArgs: Accessor<T>, apply: (value: T) => Disposer): void => {
    const argsKey = createMemo(() => stableWireKey(resolveArgs()));

    trackedEffect(argsKey, () => apply(resolveArgs()));
};
