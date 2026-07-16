import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";

import { resolveLunoraClient } from "./client";

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free).
 */
const FLAGS_EVAL_PATH = "__lunora_flags__:eval";

/**
 * The value kinds a flag resolves to — OpenFeature's boolean / number / string / structured (JSON) flags.
 * @experimental
 */
type FlagValue = boolean | number | string | Record<string, unknown> | unknown[] | null;

/**
 * Targeting context bag forwarded to the OpenFeature provider.
 * @experimental
 */
type FlagContext = Record<string, unknown>;

/** Wire args the generated flag-subscription read override reads. */
interface FlagSubscribeArgs extends Record<string, unknown> {
    context?: Record<string, unknown>;
    default: unknown;
    key: string;
    type: "boolean" | "number" | "object" | "string";
}

/** Map a default value to the OpenFeature flag kind. */
const flagKind = (value: unknown): FlagSubscribeArgs["type"] => {
    const kind = typeof value;

    if (kind === "boolean" || kind === "number" || kind === "string") {
        return kind;
    }

    return "object";
};

/** A typed reference to the reserved flags channel. */
const flagsReference = { __lunoraRef: FLAGS_EVAL_PATH } as FunctionReference<"query", FlagSubscribeArgs, FlagValue>;

/**
 * `FlagOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface FlagOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * Per-call targeting context merged on top of the app's default `identify`
     * targeting key.
     */
    context?: FlagContext;

    /** `DestroyRef` whose `onDestroy` tears down the subscription. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;
}

/**
 * Subscribe to a single feature flag, live over Lunora's WebSocket.
 *
 * The returned signal holds `defaultValue` until the first evaluation lands, then
 * the server's resolved value — re-pushed whenever the provider re-evaluates.
 * The flag's kind is inferred from `defaultValue`'s runtime type, so
 * `flag("dark", false)` reads a boolean and `flag("hero", "control")` a string.
 *
 * Evaluation runs through whatever OpenFeature provider the app wired in
 * `lunora/flags.ts`; the read never throws — a provider error resolves the
 * default (the same fail-open contract as server-side `ctx.flags`).
 *
 * Call from an injection context:
 * ```ts
 * readonly darkMode = flag("dark-mode", false);
 * ```
 * @experimental
 */
export const flag = <T extends FlagValue>(key: string, defaultValue: T, options: FlagOptions = {}): Signal<T> => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const type = flagKind(defaultValue);

    const value = signal<T>(defaultValue);

    let unsubscribe: Unsubscribe | undefined;

    try {
        unsubscribe = client.subscribe(
            flagsReference,
            { context: options.context, default: defaultValue, key, type },
            (next) => {
                value.set(next as T);
            },
            {
                onError: () => {
                    value.set(defaultValue);
                },
            },
        );
    } catch {
        // The attach threw (e.g. the client is closed). Keep the default.
    }

    if (unsubscribe) {
        destroyRef.onDestroy(unsubscribe);
    }

    return value.asReadonly();
};

/**
 * `FlagsOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface FlagsOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * Targeting context shared by every flag in the set, merged on top of the
     * app's default `identify` targeting key.
     */
    context?: FlagContext;

    /** `DestroyRef` whose `onDestroy` tears down the subscriptions. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;
}

/**
 * Subscribe to several feature flags at once, live over Lunora's WebSocket.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the returned signal holds the same-shaped record with resolved
 * values (the defaults until each evaluation lands).
 *
 * Call from an injection context:
 * ```ts
 * readonly features = flags({ "dark-mode": false, "new-editor": false });
 * ```
 * @experimental
 */
export const flags = <T extends Record<string, FlagValue>>(flagDefaults: T, options: FlagsOptions = {}): Signal<T> => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const values = signal<T>({ ...flagDefaults });

    const unsubscribes: Unsubscribe[] = [];

    for (const [key, defaultValue] of Object.entries(flagDefaults)) {
        try {
            const unsub = client.subscribe(
                flagsReference,
                { context: options.context, default: defaultValue, key, type: flagKind(defaultValue) },
                (next) => {
                    values.set({ ...values(), [key]: next });
                },
                {
                    onError: () => {
                        values.set({ ...values(), [key]: defaultValue });
                    },
                },
            );

            unsubscribes.push(unsub);
        } catch {
            // Keep this flag's default; flags fail open.
        }
    }

    destroyRef.onDestroy(() => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    });

    return values.asReadonly();
};

export type { FlagContext, FlagValue };
