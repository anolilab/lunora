/**
 * Sequence-number types for the event log.
 *
 * Three namespaces match the vocabulary established by event-sourcing:
 *
 * | Namespace | Shape              | Producer                  | Consumer                     |
 * |-----------|--------------------|---------------------------|------------------------------|
 * | `Global`  | `number`           | `EventLog` / `EventLogDO` | Materializers, subscribers   |
 * | `Input`   | No seq (optimistic) | `defineEvents` factories  | `EventLog.append` / DO client|
 * | `Client`  | `{generation,seq}`  | _(future: rebase engine)_ | _(future: rebase-aware code)_|
 * @module
 */

// ── Global ───────────────────────────────────────────────────────────────────

/**
 * A server-authoritative (global) sequence number.
 *
 * Monotonically increasing, assigned by `EventLog` (in-memory) or
 * `EventLogDO` (Durable Object). All confirmed log entries carry a
 * `GlobalSeq`.
 * @experimental
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public API alias that gives the sequence-number namespace a distinct, searchable name.
export type GlobalSeq = number;

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * A client-originated composite sequence number designed to survive rebase.
 *
 * Carries the last-confirmed `global` seq, a monotonically increasing
 * `client` counter, and a `rebaseGeneration` that increments whenever the
 * client's local events are rebased onto a new upstream baseline.
 * @experimental
 */
export interface ClientSeq {
    /** Client-local monotonically increasing counter. */
    readonly client: number;
    /** The last-confirmed global sequence number. 0 for unconfirmed events. */
    readonly global: number;
    /** Incremented on every rebase. */
    readonly rebaseGeneration: number;
}

/**
 * Discriminated union of all sequence-number types.
 * @experimental
 */
export type Seq = GlobalSeq | ClientSeq;

/**
 * Narrow `Seq` to `GlobalSeq`.
 * @experimental
 */
export const isGlobalSeq = (seq: Seq): seq is GlobalSeq => typeof seq === "number";

/**
 * Narrow `Seq` to `ClientSeq`.
 * @experimental
 */
export const isClientSeq = (seq: Seq): seq is ClientSeq => typeof seq !== "number" && "rebaseGeneration" in seq;

// ── InputEvent ───────────────────────────────────────────────────────────────

/**
 * An event that has **not** yet been assigned a sequence number.
 *
 * Input events represent optimistic / command payloads before the server
 * confirms them. They carry `type`, `payload`, and `timestamp` but no
 * `seq` — the log assigns one on append.
 *
 * Create input events via `defineEvents` factories:
 *
 * ```ts
 * const event = events.chat.messageSent({ channelId: "c1", text: "hello" });
 * // event: InputEvent<"chat.messageSent", { channelId: string; text: string }>
 * ```
 * @experimental
 */
export interface InputEvent<Type extends string = string, Payload = unknown> {
    /** Arbitrary JSON-serialisable payload. */
    readonly payload: Payload;
    /** Millisecond timestamp (epoch) when the event was created. */
    readonly timestamp: number;
    /** Event type discriminator (e.g. `"chat.messageSent"`). */
    readonly type: Type;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Type guard: check whether `value` is an {@link InputEvent}.
 * @experimental
 */
export const isInputEvent = (value: unknown): value is InputEvent =>
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && "payload" in value && "timestamp" in value;
