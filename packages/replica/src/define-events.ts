/**
 * `defineEvents` — declare typed event types for event sourcing.
 *
 * Each namespace maps to a set of event types, where every event carries a
 * namespace-qualified `type` (e.g. `"chat.messageSent"`) and a typed
 * `payload`. The returned object provides factory functions that produce
 * EventLogEntry-compatible objects, plus a `_types` symbol that
 * tools like `defineMaterializer` can use for type-level inference.
 * @example
 * ```ts
 * const events = defineEvents({
 *   chat: {
 *     messageSent: v.object({ channelId: v.string(), text: v.string() }),
 *     messageDeleted: v.object({ messageId: v.string() }),
 *   },
 *   system: {
 *     userLoggedIn: v.object({ userId: v.string() }),
 *   },
 * });
 *
 * // Factory
 * const entry = events.chat.messageSent({ channelId: "c1", text: "hello", author: "alice" });
 * //    ^ { type: "chat.messageSent", payload: { channelId, text, author }, timestamp: number }
 *
 * // Type-only introspection
 * type AllEvents = typeof events._types;
 * //    ^ { "chat.messageSent": { channelId: string; text: string; author: string }; ... }
 * ```
 */

import type { InputEvent } from "./seq";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Map a namespace-and-name pair to a qualified event type string. */
type QualifiedType<Ns extends string, Name extends string> = `${Ns}.${Name}`;

/**
 * Extract the payload type from an event schema.
 *
 * A `@lunora/values` validator (e.g. `v.object(...)`) carries its output type on
 * the phantom `__type` field (the same hook `Infer` reads), so match that FIRST
 * — otherwise a validator, being object-shaped, would fall through to the
 * `Record` branch and resolve to the validator instance itself rather than its
 * validated `{ … }` output. A bare factory function or plain descriptor object
 * is still supported as a fallback.
 */
type PayloadOf<T> = T extends { readonly __type: infer P } ? P : T extends (payload: infer P) => unknown ? P : T extends Record<string, unknown> ? T : never;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/**
 * Produce `{ "ns.name": Payload }` for every event, merged.
 */
type EventTypeMap<TDefinition extends Record<string, Record<string, unknown>>> = UnionToIntersection<
    {
        [Ns in keyof TDefinition & string]: {
            [Name in keyof TDefinition[Ns] & string]: { [K in QualifiedType<Ns, Name>]: PayloadOf<TDefinition[Ns][Name]> };
        }[keyof TDefinition[Ns] & string];
    }[keyof TDefinition & string]
>;

// ── Factory result type ──────────────────────────────────────────────────

/**
 * A factory function that creates an {@link InputEvent} for a specific event type.
 *
 * The returned event has no `seq` — it is an optimistic / command payload
 * that the event log will assign a sequence number to on append.
 * @experimental
 */
export interface EventFactory<Type extends string, Payload> {
    (payload: Payload): InputEvent<Type, Payload>;
    /** The fully qualified event type string (e.g. `"chat.messageSent"`). */
    readonly type: Type;
}

/**
 * The namespace object returned for each group of events.
 * @experimental
 */
export type EventNamespace<Ns extends string, TDefinition extends Record<string, unknown>> = {
    [Name in keyof TDefinition & string]: EventFactory<QualifiedType<Ns, Name>, PayloadOf<TDefinition[Name]>>;
};

/**
 * The full result of {@link defineEvents}.
 * @experimental
 */
export type EventsDefinition<TDefinition extends Record<string, Record<string, unknown>>> = {
    [Ns in keyof TDefinition & string]: EventNamespace<Ns, TDefinition[Ns]>;
} & {
    /** Type-level map of event type → payload shape. Useful for generic code. */
    readonly _types: EventTypeMap<TDefinition>;
};

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Declare typed event types for event sourcing.
 *
 * Each key under a namespace becomes a factory function that produces
 * an {@link InputEvent} — an optimistic / command event that the event
 * log will assign a sequence number to on append.
 * @param definition A nested object where the outer keys are namespaces
 * and the inner keys are event names mapped to their
 * payload schemas (or simple type-descriptor objects).
 * @returns An object with the same nesting structure, where each leaf is
 * a factory function plus a `.type` property.
 */
export interface DefineEventsOptions {
    /**
     * Optional version prefix for all event types.
     *
     * When set, every qualified event type is prefixed with `"v<N>."`, enabling
     * versioned event naming like `"v1.chat.messageSent"` or `"v2.chat.messageSent"`.
     * This allows materializers to evolve their handling logic based on the event
     * version without breaking backward compatibility.
     * @example "v1" → event type becomes "v1.chat.messageSent"
     */
    readonly version?: string;
}

/**
 * `defineEvents` is part of the experimental `@lunora/replica` API and may change without a major version bump.
 * @experimental
 */
export const defineEvents = <TDefinition extends Record<string, Record<string, unknown>>>(
    definition: TDefinition,
    options?: DefineEventsOptions,
): EventsDefinition<TDefinition> => {
    const result: Record<string, unknown> = {};
    const typeMap: Record<string, unknown> = {};
    const prefix = options?.version ? `${options.version}.` : "";

    for (const [namespace, events] of Object.entries(definition)) {
        const nsObject: Record<string, unknown> = {};

        for (const name of Object.keys(events)) {
            const qualifiedType = `${prefix}${namespace}.${name}`;

            // Store the type mapping for _types
            typeMap[qualifiedType] = undefined;

            const factory = Object.assign(
                (payload: unknown): InputEvent => {
                    return {
                        type: qualifiedType,
                        payload,
                        timestamp: Date.now(),
                    };
                },
                { type: qualifiedType },
            );

            nsObject[name] = factory;
        }

        result[namespace] = nsObject;
    }

    result._types = typeMap;

    return result as EventsDefinition<TDefinition>;
};
