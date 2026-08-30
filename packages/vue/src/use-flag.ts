import type { FunctionReference, Unsubscribe } from "@lunora/client";
import type { MaybeRefOrGetter, Ref } from "vue";
import { shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { stableStringify } from "../../../shared/stable-key";
import { useLunora } from "./lunora-provider";

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free).
 * Unlike `useQuery`, a flag read never issues an HTTP fetch — the reserved
 * prefix isn't a registered function, so an HTTP RPC would 404. It rides
 * Lunora's WebSocket only, seeded on subscribe.
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

/** Serialize the optional targeting context into a stable watch key (`""` when absent). */
const serializeContext = (context: FlagContext | undefined): string => (context === undefined ? "" : stableStringify(context));

/**
 * Subscribe to a single feature flag, live over Lunora's WebSocket.
 *
 * The returned `ref` holds `defaultValue` until the first evaluation lands, then
 * the server's resolved value — re-pushed whenever the provider re-evaluates
 * (e.g. a flag is toggled in Cloudflare Flagship). The flag's kind is inferred
 * from `defaultValue`'s runtime type, so `useFlag("dark", false)` reads a boolean
 * and `useFlag("hero", "control")` a string.
 *
 * `key` and `context` may be plain values, `ref`s, or getters: passing a reactive
 * source makes the subscription reactive — when it changes the old subscription
 * is torn down and a fresh one opens. `context` supplies a per-call targeting
 * context merged on top of the app's default `identify` targeting key.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`) — both an
 * attach throw and a provider error pushed mid-session. Call inside `setup()`
 * (or any active effect scope); the subscription tears down on unmount. During
 * SSR no subscription opens at all and the ref stays at `defaultValue`.
 */
const useFlag = <T extends FlagValue>(
    key: MaybeRefOrGetter<string>,
    defaultValue: T,
    context?: MaybeRefOrGetter<FlagContext | undefined>,
): Readonly<Ref<T>> => {
    const client = useLunora();
    const type = flagKind(defaultValue);
    const value = shallowRef<T>(defaultValue) as Ref<T>;

    // Re-subscribe whenever the (reactive) key/context changes. The watch source
    // is a stable string so an equal-but-new context object never churns the
    // subscription; the latest key/context are re-read inside the callback.
    watch(
        () => `${toValue(key)}\u0000${serializeContext(toValue(context))}`,
        (_serialized, _previous, onCleanup) => {
            const currentKey = toValue(key);
            const currentContext = toValue(context);

            // A different key/context is a different flag — drop the prior value so
            // the UI shows this flag's default until its first evaluation lands.
            value.value = defaultValue;

            // Client-only: `{ immediate: true }` fires this synchronously inside
            // `setup()`, so during `renderToString` an un-guarded subscribe opens a
            // socket that no unmount ever tears down (see `use-presence.ts`'s guard
            // rationale) — one stranded subscription per rendered request. The ref
            // already holds the default, which is what SSR HTML should show.
            if (!isBrowser()) {
                return;
            }

            let unsubscribe: Unsubscribe;

            try {
                unsubscribe = client.subscribe(
                    flagsReference,
                    { context: currentContext, default: defaultValue, key: currentKey, type },
                    (next) => {
                        value.value = next as T;
                    },
                    {
                        // Fail open: a provider error mid-session resolves the default
                        // rather than freezing on the last resolved value.
                        onError: () => {
                            value.value = defaultValue;
                        },
                    },
                );
            } catch {
                // The attach threw (e.g. the client is closed). Keep the default;
                // there is no error channel for a flag read — it fails open by design.
                return;
            }

            onCleanup(unsubscribe);
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
 * values (the defaults until each evaluation lands). A single `context` applies
 * to every flag and may be reactive. This is the batched form of {@link useFlag}
 * — one watcher manages one subscription per key.
 */
const useFlags = <T extends Record<string, FlagValue>>(flags: T, context?: MaybeRefOrGetter<FlagContext | undefined>): Readonly<Ref<T>> => {
    const client = useLunora();
    const values = shallowRef<T>(flags) as Ref<T>;

    // The flag set is fixed for the composable's lifetime; only the context is
    // reactive, so the watch key combines the (stable) spec with the context.
    const spec = stableStringify(flags);

    watch(
        () => `${spec}\u0000${serializeContext(toValue(context))}`,
        (_serialized, _previous, onCleanup) => {
            const currentContext = toValue(context);

            // Reset to defaults so a changed context never shows stale values.
            values.value = flags;

            // Client-only, for the same reason as {@link useFlag}: this watcher body
            // runs synchronously inside `setup()` during `renderToString`, and
            // nothing on the server ever unmounts to run `onCleanup`.
            if (!isBrowser()) {
                return;
            }

            const unsubscribes: Unsubscribe[] = [];

            for (const [key, defaultValue] of Object.entries(flags)) {
                try {
                    unsubscribes.push(
                        client.subscribe(
                            flagsReference,
                            { context: currentContext, default: defaultValue, key, type: flagKind(defaultValue) },
                            (next) => {
                                values.value = { ...values.value, [key]: next };
                            },
                            {
                                // Fail open: a provider error resolves this flag's default.
                                onError: () => {
                                    values.value = { ...values.value, [key]: defaultValue };
                                },
                            },
                        ),
                    );
                } catch {
                    // The attach threw — keep this flag's default; flags fail open.
                }
            }

            onCleanup(() => {
                for (const unsubscribe of unsubscribes) {
                    unsubscribe();
                }
            });
        },
        { immediate: true },
    );

    return values;
};

export type { FlagContext, FlagValue };
export { useFlag, useFlags };
