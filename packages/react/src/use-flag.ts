"use client";

import type { FunctionReference, Unsubscribe } from "@lunora/client";
import { useEffect, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";
import { stableStringify } from "./query-key";

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free), and
 * the studio's admin reads use `__lunora_admin__:listFlags`; this is the
 * client-facing reactive channel. Unlike `useQuery`, a flag read never issues an
 * HTTP fetch — the reserved prefix isn't a registered function, so an HTTP RPC
 * would 404. It rides Lunora's WebSocket only, seeded on subscribe.
 */
const FLAGS_EVAL_PATH = "__lunora_flags__:eval";

/** A targeting context merged on top of the app's default (`defineFlags({ identify })`). */
type FlagContext = Record<string, unknown>;

/** The value kinds a flag resolves to — OpenFeature's boolean / number / string / structured (JSON) flags. */
type FlagValue = boolean | number | string | { [key: string]: unknown } | unknown[] | null;

/** Wire args the generated flag-subscription read override reads: the key, its value kind, the fallback, and the targeting context. */
interface FlagSubscribeArgs extends Record<string, unknown> {
    context?: FlagContext;
    default: unknown;
    key: string;
    type: "boolean" | "number" | "object" | "string";
}

/** Map a default value to the OpenFeature flag kind the server evaluates it as. */
const flagKind = (value: unknown): FlagSubscribeArgs["type"] => {
    const kind = typeof value;

    if (kind === "boolean" || kind === "number" || kind === "string") {
        return kind;
    }

    return "object";
};

/** A typed reference to the reserved flags channel so `client.subscribe` infers its args/return. */
const flagsReference = { __lunoraRef: FLAGS_EVAL_PATH } as FunctionReference<"query", FlagSubscribeArgs, FlagValue>;

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

        let unsubscribe: Unsubscribe;

        try {
            unsubscribe = client.subscribe(flagsReference, { context: currentContext, default: currentDefault, key, type }, (next) => {
                if (!cancelled) {
                    setValue(next as T);
                }
            });
        } catch {
            // The attach threw (e.g. the client is closed). Keep the default; there
            // is no error channel for a flag read — it fails open by design.
            return () => {
                cancelled = true;
            };
        }

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
            try {
                unsubscribes.push(
                    client.subscribe(flagsReference, { context: currentContext, default: defaultValue, key, type: flagKind(defaultValue) }, (next) => {
                        if (!cancelled) {
                            setValues((previous) => {
                                return { ...previous, [key]: next };
                            });
                        }
                    }),
                );
            } catch {
                // The attach threw — keep this flag's default; flags fail open.
            }
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

export type { FlagContext, FlagValue };
export { useFlag, useFlags };
