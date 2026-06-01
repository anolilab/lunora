/**
 * Opaque reference to a Cirrus function. Mirrors the `FunctionReference` shape
 * emitted by `@cirrus/codegen` (and consumed by `@cirrus/client`). We avoid a
 * direct dependency to keep this package usable from the codegen pipeline
 * itself.
 *
 * The runtime identifier lives in `__cirrusRef` — this MUST stay in lockstep
 * with the codegen emit + `@cirrus/client`'s `FunctionReference`.
 */
export interface FunctionReference {
    readonly __cirrusRef: string;
    /** Marker phantom type — discriminates queries / mutations / actions. */
    readonly _kind?: "query" | "mutation" | "action";
}

export type ArgsOf<F extends FunctionReference> = F extends { _args?: infer A } ? A : Record<string, unknown>;

export interface RunOptions {
    /** Routing hint — forwarded to the Worker so the call lands on the right shard. */
    shardKey?: string;
}

export interface ScheduleRecord {
    args: Record<string, unknown>;
    enqueuedAt: number;
    functionPath: string;
    id: string;
    scheduledFor: number;
    shardKey?: string;
}

export interface Scheduler {
    cancel: (id: string) => Promise<{ cancelled: boolean }>;
    runAfter: <F extends FunctionReference>(delayMs: number, function_: F, args: ArgsOf<F>, options?: RunOptions) => Promise<{ id: string; scheduledFor: number }>;
    runAt: <F extends FunctionReference>(date: Date | number, function_: F, args: ArgsOf<F>, options?: RunOptions) => Promise<{ id: string; scheduledFor: number }>;
}

/** Subset of `DurableObjectNamespace` the package consumes. */
export interface DurableObjectNamespaceLike {
    get: (id: DurableObjectIdLike) => DurableObjectStubLike;
    idFromName: (name: string) => DurableObjectIdLike;
}

export interface DurableObjectIdLike {
    toString: () => string;
}

export interface DurableObjectStubLike {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface CirrusSchedulerOptions {
    /** Optional named instance — useful for tenant isolation. Default `default`. */
    instanceName?: string;
    /** Binding to the `SchedulerDO` durable object namespace. */
    namespace: DurableObjectNamespaceLike;

    /**
     * Origin where the Worker is mounted. SchedulerDO uses this base URL when
     * dispatching scheduled functions back to the Worker on alarm fire.
     */
    originUrl: string;
}
