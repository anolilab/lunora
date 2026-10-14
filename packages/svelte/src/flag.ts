import type { LunoraClient, Unsubscribe } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import type { FlagValue } from "../../../shared/flag-subscription";
import { subscribeFlag } from "../../../shared/flag-subscription";
import { isBrowser } from "../../../shared/is-browser";
import { isClient } from "./agent";
import { getLunoraClient } from "./context";

/**
 * Open one flag subscription, gated on a browser `window`. The fail-open
 * contract itself lives in the shared {@link subscribeFlag}.
 *
 * A `readable`'s start function runs on its first subscriber, and `$flag` in a
 * template subscribes during `renderToString` — so without this the store opens
 * a socket on the server. Svelte unsubscribes synchronously once the render
 * completes, so this is a per-render open rather than the permanent leak the
 * same defect caused in `@lunora/vue` and `@lunora/angular` (which never
 * unmount). It is still a socket per rendered request against a client whose
 * same-origin URL does not resolve server-side — and on a client built with a
 * relative/empty URL the first subscribe throws straight out of the render.
 * Every subscribing primitive in this package carries the same guard. The store
 * holds its default until hydration.
 */
const openFlag = <T extends FlagValue>(client: LunoraClient, key: string, defaultValue: T, set: (value: T) => void): Unsubscribe =>
    isBrowser() ? subscribeFlag<T>(client, { default: defaultValue, key }, set) : () => {};

/**
 * Open a single feature flag as a Svelte readable store, live over Lunora's
 * WebSocket. Read it with the `$store` idiom (`{$darkMode}`).
 *
 * The store holds `defaultValue` until the first evaluation lands, then the
 * server's resolved value — re-emitted whenever the provider re-evaluates (e.g. a
 * flag is toggled in Cloudflare Flagship). The flag's kind is inferred from
 * `defaultValue`'s runtime type, so `flag("dark", false)` reads a boolean and
 * `flag("hero", "control")` a string.
 *
 * The reactive channel is public, so the server evaluates every flag under the
 * socket's own verified identity — the targeting key your `defineFlags({
 * identify })` derives — and accepts no client-supplied targeting context. For
 * evaluation under a context you compute, call `ctx.flags.*` inside a query,
 * mutation, or action and return the resolved value.
 *
 * The subscription opens lazily on the first `$`-read and tears down when the
 * last subscriber detaches. Pass `client` explicitly, or omit it to resolve the
 * ambient client published by `setLunoraClient`. Evaluation never throws — a
 * provider error resolves the default (the same fail-open contract as `ctx.flags`).
 */
export function flag<T extends FlagValue>(key: string, defaultValue: T): Readable<T>;
export function flag<T extends FlagValue>(client: LunoraClient, key: string, defaultValue: T): Readable<T>;
export function flag<T extends FlagValue>(clientOrKey: LunoraClient | string, keyOrDefault: T | string, maybeDefault?: T): Readable<T> {
    const hasExplicitClient = isClient(clientOrKey);
    const client = hasExplicitClient ? clientOrKey : getLunoraClient();
    const key = (hasExplicitClient ? keyOrDefault : clientOrKey) as string;
    const defaultValue = (hasExplicitClient ? maybeDefault : keyOrDefault) as T;

    return readable<T>(defaultValue, (set) => openFlag(client, key, defaultValue, set));
}

/**
 * Open several feature flags at once as a single Svelte readable store of the
 * resolved record, live over Lunora's WebSocket.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the store holds the same-shaped record with resolved values (the
 * defaults until each evaluation lands). This is the batched form of {@link flag}
 * — one store, one subscription per key, torn down together when the last
 * subscriber detaches. Like {@link flag} it evaluates under the socket's
 * server-verified identity only.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 */
export function flags<T extends Record<string, FlagValue>>(flagDefaults: T): Readable<T>;
export function flags<T extends Record<string, FlagValue>>(client: LunoraClient, flagDefaults: T): Readable<T>;
export function flags<T extends Record<string, FlagValue>>(clientOrFlags: LunoraClient | T, maybeFlags?: T): Readable<T> {
    const hasExplicitClient = isClient(clientOrFlags);
    const client = hasExplicitClient ? clientOrFlags : getLunoraClient();
    const flagDefaults = (hasExplicitClient ? maybeFlags : clientOrFlags) as T;

    return readable<T>(flagDefaults, (set) => {
        let current = { ...flagDefaults };
        const unsubscribes: Unsubscribe[] = [];

        for (const [key, defaultValue] of Object.entries(flagDefaults)) {
            unsubscribes.push(
                openFlag(client, key, defaultValue, (next) => {
                    current = { ...current, [key]: next };
                    set(current);
                }),
            );
        }

        return () => {
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
    });
}

export type { FlagValue } from "../../../shared/flag-subscription";
