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
    /** Route the call to a specific shard (defaults to the worker's root shard). */
    shardKey?: string;
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
