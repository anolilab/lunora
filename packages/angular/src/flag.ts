import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { LunoraClient, Unsubscribe } from "@lunora/client";

import type { FlagContext as SharedFlagContext, FlagValue as SharedFlagValue } from "../../../shared/flag-subscription";
import { subscribeFlag } from "../../../shared/flag-subscription";
import { resolveLunoraClient } from "./client";
import { shouldOpenSubscription } from "./platform";

/**
 * The value kinds a flag resolves to — OpenFeature's boolean / number / string / structured (JSON) flags.
 * @experimental
 */
type FlagValue = SharedFlagValue;

/**
 * Targeting context bag forwarded to the OpenFeature provider.
 * @experimental
 */
type FlagContext = SharedFlagContext;

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
 * default (the same fail-open contract as server-side `ctx.flags`). No
 * subscription opens during SSR; the signal stays at `defaultValue`.
 *
 * Call from an injection context:
 * ```ts
 * readonly darkMode = flag("dark-mode", false);
 * ```
 * @experimental
 */
export const flag = <T extends FlagValue>(key: string, defaultValue: T, options: FlagOptions = {}): Signal<T> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const value = signal<T>(defaultValue);

    // Skip the socket on the Angular server platform (SSR): Angular runs field
    // initializers during a server render and Node 22+ ships a global
    // `WebSocket`, so an un-gated subscribe either throws on the default relative
    // `/_lunora/ws` (swallowed below, leaving the flag permanently unresolved) or
    // opens a real server-side socket per render. The signal stays at
    // `defaultValue` — the fail-open contract — and the browser render attaches.
    if (!shouldOpenSubscription(fromInjectionContext)) {
        return value.asReadonly();
    }

    // `subscribeFlag` owns the fail-open contract (attach throw and
    // server-pushed provider error both resolve the default).
    destroyRef.onDestroy(
        subscribeFlag<T>(client, { context: options.context, default: defaultValue, key }, (next) => {
            value.set(next);
        }),
    );

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
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const values = signal<T>({ ...flagDefaults });

    // Client-only, for the same reason as {@link flag}.
    if (!shouldOpenSubscription(fromInjectionContext)) {
        return values.asReadonly();
    }

    const unsubscribes: Unsubscribe[] = [];

    for (const [key, defaultValue] of Object.entries(flagDefaults)) {
        unsubscribes.push(
            subscribeFlag(client, { context: options.context, default: defaultValue, key }, (next) => {
                values.set({ ...values(), [key]: next });
            }),
        );
    }

    destroyRef.onDestroy(() => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    });

    return values.asReadonly();
};

export type { FlagContext, FlagValue };
