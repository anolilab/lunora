"use client";

import type { Unsubscribe } from "@lunora/client";
import { useEffect, useRef, useState } from "react";

import type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
import { flagKind, subscribeFlag } from "../../../shared/flag-subscription";
import { useLunora } from "./lunora-provider";
import { stableStringify } from "./query-key";

/**
 * Subscribe to a single feature flag, live over Lunora's WebSocket.
 *
 * Returns `defaultValue` until the first evaluation lands, then the server's
 * resolved value — re-pushed whenever the provider re-evaluates (e.g. a flag is
 * toggled in Cloudflare Flagship). The flag's kind is inferred from
 * `defaultValue`'s runtime type, so `useFlag("dark", false)` reads a boolean and
 * `useFlag("hero", "control")` a string. `context` supplies a per-call targeting
 * context merged on top of the app's default `identify` targeting key.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`).
 */
const useFlag = <T extends FlagValue>(key: string, defaultValue: T, context?: FlagContext): T => {
    const client = useLunora();
    const [value, setValue] = useState<T>(defaultValue);

    const type = flagKind(defaultValue);
    const serializedContext = context === undefined ? "" : stableStringify(context);

    // A different key/type/context is a different flag. Reset to this flag's
    // default DURING render (guarded by a ref) so the first paint after the
    // change never commits the previous flag's resolved value — which would
    // flash the wrong experiment arm. The effect below re-subscribes and also
    // seeds the default; doing it here as well closes the one-frame gap before
    // that effect runs. Same render-phase reset pattern usePaginatedCore uses.
    const resetKey = `${key}::${type}::${serializedContext}`;
    const resetKeyRef = useRef(resetKey);

    // react-doctor-disable-next-line react-hooks-js/refs -- intentional: React's sanctioned "reset state when an input changes" pattern — compare a render-phase ref to the current reset key and set state during render, guarded so it runs once per change.
    if (resetKeyRef.current !== resetKey) {
        // react-doctor-disable-next-line react-hooks-js/refs -- intentional: writing the ref guard here is what makes the render-phase reset fire exactly once per input change.
        resetKeyRef.current = resetKey;
        setValue(defaultValue);
    }

    // The latest default/context, read at subscribe time so re-creating an equal
    // context object (or default) doesn't churn the subscription — the effect
    // keys off `key`/`type`/`serializedContext`, which capture every real change.
    const latest = useRef({ context, defaultValue });

    useEffect(() => {
        latest.current = { context, defaultValue };
    });

    useEffect(() => {
        let cancelled = false;
        const { context: currentContext, defaultValue: currentDefault } = latest.current;

        // A different key/context is a different flag — drop the prior value so the
        // UI shows this flag's default until its first evaluation lands.
        setValue(currentDefault);

        // `subscribeFlag` owns the fail-open contract (attach throw and
        // server-pushed provider error both resolve the default).
        const unsubscribe = subscribeFlag<T>(client, { context: currentContext, default: currentDefault, key }, (next) => {
            if (!cancelled) {
                setValue(next);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [client, key, type, serializedContext]);

    return value;
};

/**
 * Subscribe to several feature flags at once, live over Lunora's WebSocket.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the result is the same-shaped record with resolved values (the
 * defaults until each evaluation lands). A single `context` applies to every
 * flag. This is the batched form of {@link useFlag} — one effect manages one
 * subscription per key, so it stays rules-of-hooks-safe even as the flag set
 * changes between renders.
 */
const useFlags = <T extends Record<string, FlagValue>>(flags: T, context?: FlagContext): T => {
    const client = useLunora();
    const [values, setValues] = useState<T>(flags);

    // The flag set is identified by its keys + defaults; an equal-but-new object
    // doesn't re-subscribe. The context is serialised separately.
    const spec = stableStringify(flags);
    const serializedContext = context === undefined ? "" : stableStringify(context);

    // Reset to the new defaults DURING render (guarded by a ref) when the flag
    // set or context changes, so the first paint returns a record shaped like
    // the new `flags` — not the previous state object, which would be missing
    // the new keys and still carry the old ones (violating the declared `T`).
    // The effect below also seeds the defaults; this closes the one-frame gap.
    const resetKey = `${spec}::${serializedContext}`;
    const resetKeyRef = useRef(resetKey);

    // react-doctor-disable-next-line react-hooks-js/refs -- intentional: React's sanctioned "reset state when an input changes" pattern — compare a render-phase ref to the current reset key and set state during render, guarded so it runs once per change.
    if (resetKeyRef.current !== resetKey) {
        // react-doctor-disable-next-line react-hooks-js/refs -- intentional: writing the ref guard here is what makes the render-phase reset fire exactly once per input change.
        resetKeyRef.current = resetKey;
        setValues(flags);
    }

    const latest = useRef({ context, flags });

    useEffect(() => {
        latest.current = { context, flags };
    });

    useEffect(() => {
        let cancelled = false;
        const { context: currentContext, flags: currentFlags } = latest.current;

        // Reset to defaults so a changed flag set never shows another set's values.
        setValues(currentFlags);

        const unsubscribes: Unsubscribe[] = [];

        for (const [key, defaultValue] of Object.entries(currentFlags)) {
            unsubscribes.push(
                subscribeFlag(client, { context: currentContext, default: defaultValue, key }, (next) => {
                    if (!cancelled) {
                        setValues((previous) => {
                            return { ...previous, [key]: next };
                        });
                    }
                }),
            );
        }

        return () => {
            cancelled = true;

            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
    }, [client, spec, serializedContext]);

    return values;
};

export type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
export { useFlag, useFlags };
