import type { Unsubscribe } from "@lunora/client";
import type { MaybeRefOrGetter, Ref } from "vue";
import { shallowRef, toValue, watch } from "vue";

import type { FlagValue } from "../../../shared/flag-subscription";
import { subscribeFlag } from "../../../shared/flag-subscription";
import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";

/**
 * Subscribe to a single feature flag, live over Lunora's WebSocket.
 *
 * The returned `ref` holds `defaultValue` until the first evaluation lands, then
 * the server's resolved value — re-pushed whenever the provider re-evaluates
 * (e.g. a flag is toggled in Cloudflare Flagship). The flag's kind is inferred
 * from `defaultValue`'s runtime type, so `useFlag("dark", false)` reads a boolean
 * and `useFlag("hero", "control")` a string.
 *
 * `key` may be a plain value, a `ref`, or a getter: passing a reactive source
 * makes the subscription reactive — when it changes the old subscription is torn
 * down and a fresh one opens.
 *
 * The reactive channel is public, so the server evaluates every flag under the
 * socket's own verified identity — the targeting key your `defineFlags({
 * identify })` derives — and accepts no client-supplied targeting context. For
 * evaluation under a context you compute, call `ctx.flags.*` inside a query,
 * mutation, or action and return the resolved value.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`) — both an
 * attach throw and a provider error pushed mid-session. Call inside `setup()`
 * (or any active effect scope); the subscription tears down on unmount. During
 * SSR no subscription opens at all and the ref stays at `defaultValue`.
 */
const useFlag = <T extends FlagValue>(key: MaybeRefOrGetter<string>, defaultValue: T): Readonly<Ref<T>> => {
    const client = useLunora();
    const value = shallowRef<T>(defaultValue) as Ref<T>;

    // Re-subscribe whenever the (reactive) key changes.
    watch(
        () => toValue(key),
        (currentKey, _previous, onCleanup) => {
            // A different key is a different flag — drop the prior value so the UI
            // shows this flag's default until its first evaluation lands.
            value.value = defaultValue;

            // Client-only: `{ immediate: true }` fires this synchronously inside
            // `setup()`, so during `renderToString` an un-guarded subscribe opens a
            // socket that no unmount ever tears down (see `use-presence.ts`'s guard
            // rationale) — one stranded subscription per rendered request. The ref
            // already holds the default, which is what SSR HTML should show.
            if (!isBrowser()) {
                return;
            }

            // `subscribeFlag` owns the fail-open contract (attach throw and
            // server-pushed provider error both resolve the default).
            onCleanup(
                subscribeFlag<T>(client, { default: defaultValue, key: currentKey }, (next) => {
                    value.value = next;
                }),
            );
        },
        { immediate: true },
    );

    return value;
};

/**
 * Subscribe to several feature flags at once, live over Lunora's WebSocket.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the returned `ref` holds the same-shaped record with resolved
 * values (the defaults until each evaluation lands). This is the batched form of
 * {@link useFlag} — one subscription per key, torn down together when the
 * enclosing effect scope stops. Like {@link useFlag} it evaluates under the
 * socket's server-verified identity only. The flag set is fixed for the
 * composable's lifetime, so nothing here is reactive.
 */
const useFlags = <T extends Record<string, FlagValue>>(flags: T): Readonly<Ref<T>> => {
    const client = useLunora();
    const values = shallowRef<T>(flags) as Ref<T>;

    // Client-only, for the same reason as {@link useFlag}: this runs
    // synchronously inside `setup()` during `renderToString`, and nothing on the
    // server ever unmounts to tear the subscriptions down.
    if (!isBrowser()) {
        return values;
    }

    const unsubscribes: Unsubscribe[] = [];

    for (const [key, defaultValue] of Object.entries(flags)) {
        unsubscribes.push(
            subscribeFlag(client, { default: defaultValue, key }, (next) => {
                values.value = { ...values.value, [key]: next };
            }),
        );
    }

    onScopeDisposeOrWarn(() => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    }, "[@lunora/vue] useFlags called with no active effect scope — its live subscriptions will not be cleaned up automatically. Call it inside setup()/an effect scope.");

    return values;
};

export type { FlagValue } from "../../../shared/flag-subscription";
export { useFlag, useFlags };
