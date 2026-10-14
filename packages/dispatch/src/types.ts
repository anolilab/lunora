/**
 * Shared types for dispatching a Lunora function back into the worker from a
 * server-initiated context (a workflow body, a queue handler, a scheduled job).
 * Node-safe — no Cloudflare runtime imports — so the consumers stay unit-testable
 * with plain-object doubles.
 */

/** Opaque generated function reference (`api.foo.bar`), carrying its dispatch id. */
export interface FunctionReference {
    __lunoraRef: string;
}

/** Infer the args object a {@link FunctionReference} expects (loose at the boundary). */
export type ArgsOf<F> = F extends FunctionReference ? Record<string, unknown> : never;

/** Options for a function call made via a dispatch runner. */
export interface RunFunctionOptions {
    /**
     * The at-least-once dedup key for THIS ONE CALL, sent to the dispatch
     * endpoint as the body's `id` and forwarded to the shard as the
     * replay-dedup `mutationId` — so a redelivery that re-runs the same call
     * applies it exactly once instead of twice.
     *
     * Must be unique per call and stable across redeliveries. It is NOT
     * {@link RunFunctionOptions.messageId}: the shard's dedup table is keyed
     * `(identity, mutationId)` with no function path in it, and every
     * server-initiated dispatch shares the `"system:"` identity, so reusing
     * one id across two calls makes the second return the FIRST call's cached
     * result without ever executing. A per-message id is 1:N with the calls a
     * handler makes; this is 1:1.
     *
     * `@lunora/queue`'s `message.run` derives one automatically as
     * `<messageId>#<n>`, `n` counting that message's calls in order. That is
     * stable across redeliveries because the handler replays from the start —
     * it relies on the handler issuing its `run` calls in a DETERMINISTIC
     * order, which at-least-once replay already assumes. A handler whose call
     * order varies per attempt (branching on `Date.now()`, `Math.random()`,
     * or unordered concurrent settles) must pass its own stable ids instead.
     *
     * Optional; when omitted the dispatch is at-least-once.
     */
    dedupId?: string;

    /**
     * Correlate this call with a caller-defined message/item id (e.g. a queue
     * message's `id`), for failure attribution only — never sent to the
     * dispatch endpoint. Carried onto the `LunoraError` a deterministic
     * dispatch failure throws, so a batching consumer (`@lunora/queue`'s push
     * handler) can read it back and attribute the failure to the one item that
     * caused it instead of the whole batch. Deliberately NOT the dedup key —
     * see {@link RunFunctionOptions.dedupId}. Optional and inert when omitted.
     */
    messageId?: string;
    /** Route the call to a specific shard (defaults to the worker's root shard). */
    shardKey?: string;
    /** Abort the dispatch after this many ms; the abort is retryable. Overrides the runner's default. */
    timeoutMs?: number;
}

/** Invoke a Lunora function (query/mutation/action) by reference. The shape of `ctx.run`. */
export type DispatchRunFunction = <F extends FunctionReference>(function_: F, args?: ArgsOf<F>, options?: RunFunctionOptions) => Promise<unknown>;

/** Console-style logger prefixed for log correlation, routed to wrangler tail / Studio. */
export interface DispatchLogger {
    debug: (message: unknown, ...rest: unknown[]) => void;
    error: (message: unknown, ...rest: unknown[]) => void;
    info: (message: unknown, ...rest: unknown[]) => void;
    warn: (message: unknown, ...rest: unknown[]) => void;
}
