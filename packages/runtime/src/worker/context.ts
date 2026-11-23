import type { ResolvedIdentity } from "../identity-resolvers";

/** The caller an `authorizeShard` decision is made for (structural mirror of the public `ShardCaller`). */
interface AuthorizeShardCaller {
    functionPath?: string;
    identity: ResolvedIdentity | null;
    shardKey: string;
}

/**
 * Read-only, per-worker values the extracted clusters need, built once inside
 * `createWorker`. A helper that writes closure state (warn-once flags, the
 * env-derived admin token, the resolved security config) stays in
 * `createWorker` and is exposed here only as a function.
 */
export interface WorkerRuntimeContext {
    /** Throws when a function that must run on the default shard is addressed elsewhere. */
    readonly assertAgentRunOnDefaultShard: (functionPath: string, shardKey: string | undefined) => void;
    readonly authorizeFanOut?: (identity: ResolvedIdentity | null, table: string, functionPath: string) => boolean | Promise<boolean>;
    readonly authorizeShard?: (caller: AuthorizeShardCaller) => boolean | Promise<boolean>;
    readonly defaultShard: string;
    /** Owns the warn-once flag, so it cannot move out of `createWorker` yet. */
    readonly guardUnauthenticatedShardAccess: (kind: "fan-out" | "shard") => void;
}
