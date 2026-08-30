import type { Unsubscribe } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
import { subscribeFlag } from "../../../shared/flag-subscription";
import { stableStringify } from "../../../shared/stable-key";
import { useLunora } from "./context";
import type { MaybeAccessor } from "./create-agent";
import { resolveMaybe } from "./create-agent";
import { trackedEffect } from "./solid-compat";

/** Serialize the optional targeting context into a stable effect key (`""` when absent). */
const serializeContext = (context: FlagContext | undefined): string => (context === undefined ? "" : stableStringify(context));

/**
 * Subscribe to a single feature flag and return a reactive accessor of its value.
 *
 * The accessor reads `defaultValue` until the first evaluation lands, then the
 * server's resolved value — re-pushed whenever the provider re-evaluates (e.g. a
 * flag is toggled in Cloudflare Flagship). The flag's kind is inferred from
 * `defaultValue`'s runtime type, so `createFlag("dark", false)` reads a boolean
 * and `createFlag("hero", "control")` a string.
 *
 * `key` and `context` may be plain values or accessors; passing an accessor makes
 * the subscription reactive — when it changes the old subscription is torn down
 * (via `onCleanup`) and a fresh one opens. `context` supplies a per-call targeting
 * context merged on top of the app's default `identify` targeting key.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`).
 */
const createFlag = <T extends FlagValue>(key: MaybeAccessor<string>, defaultValue: T, context?: MaybeAccessor<FlagContext | undefined>): Accessor<T> => {
    const client = useLunora();
    const [value, setValue] = createSignal<T>(defaultValue);

    // The tracked source is a stable string built from the (reactive) key +
    // context, so the body re-runs — tearing down the previous subscription via
    // the returned disposer — only when one of them actually changes; an
    // equal-but-new context object never re-subscribes.
    trackedEffect(
        () => `${resolveMaybe(key)} ${serializeContext(resolveMaybe(context))}`,
        () => {
            const currentKey = resolveMaybe(key);
            const currentContext = resolveMaybe(context);

            // A different key/context is a different flag — drop the prior value.
            setValue(() => defaultValue);

            // `subscribeFlag` owns the fail-open contract (attach throw and
            // server-pushed provider error both resolve the default).
            return subscribeFlag<T>(client, { context: currentContext, default: defaultValue, key: currentKey }, (next) => {
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
 * (the defaults until each evaluation lands). A single `context` applies to every
 * flag and may be an accessor. This is the batched form of {@link createFlag}.
 */
const createFlags = <T extends Record<string, FlagValue>>(flags: T, context?: MaybeAccessor<FlagContext | undefined>): Accessor<T> => {
    const client = useLunora();
    const [values, setValues] = createSignal<T>(flags);

    // The flag set is fixed for the primitive's lifetime; only the context is
    // reactive, so the effect key combines the (stable) spec with the context.
    const spec = stableStringify(flags);

    trackedEffect(
        () => `${spec} ${serializeContext(resolveMaybe(context))}`,
        () => {
            const currentContext = resolveMaybe(context);

            // Reset to defaults so a changed context never shows stale values.
            setValues(() => flags);

            const unsubscribes: Unsubscribe[] = [];

            for (const [key, defaultValue] of Object.entries(flags)) {
                unsubscribes.push(
                    subscribeFlag(client, { context: currentContext, default: defaultValue, key }, (next) => {
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
        },
    );

    return values;
};

export type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
export { createFlag, createFlags };
