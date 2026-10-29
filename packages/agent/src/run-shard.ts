/**
 * The params a run starts with, its shard set from `shardKey` alone. Every run-start
 * boundary (`ctx.agents`, inbound email, inbound channels, `agentAsTool`) passes its
 * input through here, because the input is untrusted at most of them: a public
 * `agents:agentRun` client, an `onEmail` mapper over an attacker-written email, a channel
 * webhook mapper. A `shardKey` in it would point the run's tools — dispatched with the
 * admin bearer, past the per-shard authorization gate — at another tenant's shard. Only
 * the caller's own trusted shard (the starting shard DO, the parent run) is kept;
 * `undefined` means the default shard.
 */
const withRunShard = <Params extends object>(input: Params, shardKey: string | undefined): Params & { shardKey?: string } => {
    // Untyped on purpose: an inbound mapper's run type has no `shardKey`, which is exactly
    // the key a forged input smuggles in at runtime.
    const params: Record<string, unknown> = { ...(input as Record<string, unknown>) };

    delete params["shardKey"];

    if (shardKey !== undefined) {
        params["shardKey"] = shardKey;
    }

    return params as Params & { shardKey?: string };
};

export default withRunShard;
