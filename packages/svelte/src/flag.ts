import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { isClient } from "./agent";
import { getLunoraClient } from "./context";

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free).
 * Unlike `query`, a flag read never issues an HTTP fetch — the reserved prefix
 * isn't a registered function, so an HTTP RPC would 404. It rides Lunora's
 * WebSocket only, seeded on subscribe.
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

/** Open one flag subscription into a readable store's `set`, failing open to the default. */
const subscribeFlag = <T extends FlagValue>(
    client: LunoraClient,
    key: string,
    defaultValue: T,
    context: FlagContext | undefined,
    set: (value: T) => void,
): Unsubscribe => {
    try {
        return client.subscribe(flagsReference, { context, default: defaultValue, key, type: flagKind(defaultValue) }, (next) => {
            set(next as T);
        });
    } catch {
        // The attach threw (e.g. the client is closed). Keep the default; a flag
        // read has no error channel — it fails open by design.
        return () => {};
    }
};

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

    return readable<T>(defaultValue, (set) => subscribeFlag(client, key, defaultValue, context, set));
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
                subscribeFlag(client, key, defaultValue, context, (next) => {
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

export type { FlagContext, FlagValue };
