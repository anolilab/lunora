import type { FunctionReference, Unsubscribe } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createEffect, createSignal, on, onCleanup } from "solid-js";

import { stableStringify } from "../../../shared/stable-key";
import { useLunora } from "./context";
import type { MaybeAccessor } from "./create-agent";
import { resolveMaybe } from "./create-agent";

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free).
 * Unlike `createQuery`, a flag read never issues an HTTP fetch — the reserved
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
    const type = flagKind(defaultValue);
    const [value, setValue] = createSignal<T>(defaultValue);

    // `on(serializedKey, …)` re-runs the body whenever the (reactive) key/context
    // changes, tearing down the previous subscription via `onCleanup` first. The
    // source is a stable string so an equal-but-new context never re-subscribes.
    createEffect(
        on(
            () => `${resolveMaybe(key)} ${serializeContext(resolveMaybe(context))}`,
            () => {
                const currentKey = resolveMaybe(key);
                const currentContext = resolveMaybe(context);

                // A different key/context is a different flag — drop the prior value.
                setValue(() => defaultValue);

                let unsubscribe: Unsubscribe;

                try {
                    unsubscribe = client.subscribe(flagsReference, { context: currentContext, default: defaultValue, key: currentKey, type }, (next) => {
                        setValue(() => next as T);
                    });
                } catch {
                    // The attach threw (e.g. the client is closed). Keep the default;
                    // a flag read has no error channel — it fails open by design.
                    return;
                }

                onCleanup(unsubscribe);
            },
        ),
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

    createEffect(
        on(
            () => `${spec} ${serializeContext(resolveMaybe(context))}`,
            () => {
                const currentContext = resolveMaybe(context);

                // Reset to defaults so a changed context never shows stale values.
                setValues(() => flags);

                const unsubscribes: Unsubscribe[] = [];

                for (const [key, defaultValue] of Object.entries(flags)) {
                    try {
                        unsubscribes.push(
                            client.subscribe(flagsReference, { context: currentContext, default: defaultValue, key, type: flagKind(defaultValue) }, (next) => {
                                setValues((previous) => {
                                    return { ...previous, [key]: next };
                                });
                            }),
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
        ),
    );

    return values;
};

export type { FlagContext, FlagValue };
export { createFlag, createFlags };
