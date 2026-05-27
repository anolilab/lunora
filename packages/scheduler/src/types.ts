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
    id: string;
    functionPath: string;
    args: Record<string, unknown>;
    scheduledFor: number;
    shardKey?: string;
    enqueuedAt: number;
}

export interface Scheduler {
    runAfter: <F extends FunctionReference>(
        delayMs: number,
        fn: F,
        args: ArgsOf<F>,
        opts?: RunOptions,
    ) => Promise<{ id: string; scheduledFor: number }>;
    runAt: <F extends FunctionReference>(
        date: Date | number,
        fn: F,
        args: ArgsOf<F>,
        opts?: RunOptions,
    ) => Promise<{ id: string; scheduledFor: number }>;
    cancel: (id: string) => Promise<{ cancelled: boolean }>;
}

/** Subset of `DurableObjectNamespace` the package consumes. */
export interface DurableObjectNamespaceLike {
    idFromName: (name: string) => DurableObjectIdLike;
    get: (id: DurableObjectIdLike) => DurableObjectStubLike;
}

export interface DurableObjectIdLike {
    toString: () => string;
}

export interface DurableObjectStubLike {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface CirrusSchedulerOptions {
    /** Binding to the `SchedulerDO` durable object namespace. */
    namespace: DurableObjectNamespaceLike;
    /**
     * Origin where the Worker is mounted. SchedulerDO uses this base URL when
     * dispatching scheduled functions back to the Worker on alarm fire.
     */
    originUrl: string;
    /** Optional named instance — useful for tenant isolation. Default `default`. */
    instanceName?: string;
}
