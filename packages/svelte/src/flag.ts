import type { LunoraClient, Unsubscribe } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
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
 * same-origin URL does not resolve server-side, and every other subscribing
 * primitive in this package already guards — `presence.ts`, `agent.ts`,
 * `agent-chat.ts`, `rate-limit.ts`. The store holds its default until hydration.
 */
const openFlag = <T extends FlagValue>(
    client: LunoraClient,
    key: string,
    defaultValue: T,
    context: FlagContext | undefined,
    set: (value: T) => void,
): Unsubscribe => (isBrowser() ? subscribeFlag<T>(client, { context, default: defaultValue, key }, set) : () => {});

/**
 * Open a single feature flag as a Svelte readable store, live over Lunora's
 * WebSocket. Read it with the `$store` idiom (`{$darkMode}`).
 *
 * The store holds `defaultValue` until the first evaluation lands, then the
 * server's resolved value — re-emitted whenever the provider re-evaluates (e.g. a
 * flag is toggled in Cloudflare Flagship). The flag's kind is inferred from
 * `defaultValue`'s runtime type, so `flag("dark", false)` reads a boolean and
 * `flag("hero", "control")` a string. `context` supplies a per-call targeting
 * context merged on top of the app's default `identify` targeting key.
 *
 * The subscription opens lazily on the first `$`-read and tears down when the
 * last subscriber detaches. Pass `client` explicitly, or omit it to resolve the
 * ambient client published by `setLunoraClient`. Evaluation never throws — a
 * provider error resolves the default (the same fail-open contract as `ctx.flags`).
 */
export function flag<T extends FlagValue>(key: string, defaultValue: T, context?: FlagContext): Readable<T>;
export function flag<T extends FlagValue>(client: LunoraClient, key: string, defaultValue: T, context?: FlagContext): Readable<T>;
export function flag<T extends FlagValue>(
    clientOrKey: LunoraClient | string,
    keyOrDefault: T | string,
    defaultOrContext?: FlagContext | T,
    maybeContext?: FlagContext,
): Readable<T> {
    const hasExplicitClient = isClient(clientOrKey);
    const client = hasExplicitClient ? clientOrKey : getLunoraClient();
    const key = (hasExplicitClient ? keyOrDefault : clientOrKey) as string;
    const defaultValue = (hasExplicitClient ? defaultOrContext : keyOrDefault) as T;
    const context = (hasExplicitClient ? maybeContext : (defaultOrContext as FlagContext | undefined)) ?? undefined;

    return readable<T>(defaultValue, (set) => openFlag(client, key, defaultValue, context, set));
}

/**
 * Open several feature flags at once as a single Svelte readable store of the
 * resolved record, live over Lunora's WebSocket.
 *
 * Pass a record of `key → defaultValue`; each flag's kind is inferred from its
 * default, and the store holds the same-shaped record with resolved values (the
 * defaults until each evaluation lands). A single `context` applies to every
 * flag. This is the batched form of {@link flag} — one store, one subscription
 * per key, torn down together when the last subscriber detaches.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 */
export function flags<T extends Record<string, FlagValue>>(flagDefaults: T, context?: FlagContext): Readable<T>;
export function flags<T extends Record<string, FlagValue>>(client: LunoraClient, flagDefaults: T, context?: FlagContext): Readable<T>;
export function flags<T extends Record<string, FlagValue>>(
    clientOrFlags: LunoraClient | T,
    flagsOrContext?: FlagContext | T,
    maybeContext?: FlagContext,
): Readable<T> {
    const hasExplicitClient = isClient(clientOrFlags);
    const client = hasExplicitClient ? clientOrFlags : getLunoraClient();
    const flagDefaults = (hasExplicitClient ? flagsOrContext : clientOrFlags) as T;
    const context = (hasExplicitClient ? maybeContext : flagsOrContext) ?? undefined;

    return readable<T>(flagDefaults, (set) => {
        let current = { ...flagDefaults };
        const unsubscribes: Unsubscribe[] = [];

        for (const [key, defaultValue] of Object.entries(flagDefaults)) {
            unsubscribes.push(
                openFlag(client, key, defaultValue, context, (next) => {
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

export type { FlagContext, FlagValue } from "../../../shared/flag-subscription";
