import type { Unsubscribe } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import type { FlagValue } from "../../../shared/flag-subscription";
import { subscribeFlag } from "../../../shared/flag-subscription";
import { useLunora } from "./context";
import type { MaybeAccessor } from "./create-agent";
import { resolveMaybe } from "./create-agent";
import { onMounted, trackedEffect } from "./solid-compat";

/**
 * Subscribe to a single feature flag and return a reactive accessor of its value.
 *
 * The accessor reads `defaultValue` until the first evaluation lands, then the
 * server's resolved value — re-pushed whenever the provider re-evaluates (e.g. a
 * flag is toggled in Cloudflare Flagship). The flag's kind is inferred from
 * `defaultValue`'s runtime type, so `createFlag("dark", false)` reads a boolean
 * and `createFlag("hero", "control")` a string.
 *
 * `key` may be a plain value or an accessor; passing an accessor makes the
 * subscription reactive — when it changes the old subscription is torn down (via
 * `onCleanup`) and a fresh one opens.
 *
 * The reactive channel is public, so the server evaluates every flag under the
 * socket's own verified identity — the targeting key your `defineFlags({
 * identify })` derives — and accepts no client-supplied targeting context. For
 * evaluation under a context you compute, call `ctx.flags.*` inside a query,
 * mutation, or action and return the resolved value.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`).
 */
const createFlag = <T extends FlagValue>(key: MaybeAccessor<string>, defaultValue: T): Accessor<T> => {
    const client = useLunora();
    const [value, setValue] = createSignal<T>(defaultValue);

    // The tracked source is the (reactive) key, so the body re-runs — tearing
    // down the previous subscription via the returned disposer — only when the
    // key actually changes.
    trackedEffect(
        () => resolveMaybe(key),
        (currentKey) => {
            // A different key is a different flag — drop the prior value.
            setValue(() => defaultValue);

            // `subscribeFlag` owns the fail-open contract (attach throw and
            // server-pushed provider error both resolve the default).
            return subscribeFlag<T>(client, { default: defaultValue, key: currentKey }, (next) => {
                setValue(() => next);
            });
        },
    );

    return value;
};

/**
 * Subscribe to several feature flags at once and return a reactive accessor of
 * the resolved record.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the accessor reads the same-shaped record with resolved values
 * (the defaults until each evaluation lands). This is the batched form of
 * {@link createFlag}, and evaluates under the socket's server-verified identity
 * only. The flag set is fixed for the primitive's lifetime, so nothing here is
 * reactive — the subscriptions open on mount and tear down on cleanup.
 */
const createFlags = <T extends Record<string, FlagValue>>(flags: T): Accessor<T> => {
    const client = useLunora();
    const [values, setValues] = createSignal<T>(flags);

    onMounted(() => {
        const unsubscribes: Unsubscribe[] = [];

        for (const [key, defaultValue] of Object.entries(flags)) {
            unsubscribes.push(
                subscribeFlag(client, { default: defaultValue, key }, (next) => {
                    setValues((previous) => {
                        return { ...previous, [key]: next };
                    });
                }),
            );
        }

        return () => {
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
    });

    return values;
};

export type { FlagValue } from "../../../shared/flag-subscription";
export { createFlag, createFlags };
