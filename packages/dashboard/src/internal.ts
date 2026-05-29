import type { FunctionReference } from "@cirrus/client";

/**
 * Build a {@link FunctionReference} for a reserved admin RPC path. All admin
 * RPCs are intercepted by `ShardDO` by `functionPath` regardless of which
 * client method carries them, so the dashboard routes every admin call through
 * `client.query` — a pure one-shot RPC with no optimistic/offline machinery.
 */
export const adminRef = (path: string): FunctionReference => ({ __cirrusRef: path });

/** Translate a free-text shard key into the client's call options. Empty → root shard. */
export const callOptions = (shardKey: string): { shardKey?: string } => {
    const trimmed = shardKey.trim();

    return trimmed === "" ? {} : { shardKey: trimmed };
};

/** Narrow an unknown thrown value to a human-readable message. */
export const errorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};
