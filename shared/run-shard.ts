/**
 * The params an agent run starts with, its shard set from `shardKey` alone. Every
 * run-start boundary passes its input through here: `ctx.agents`, `agentAsTool`, inbound
 * email and channels, and a scheduled agent job. The input is untrusted at most of them:
 * an app mutation forwarding a client's args, an `onEmail` mapper over an
 * attacker-written email, a channel webhook mapper, a scheduled job whose args came from
 * a public mutation. A `shardKey` in it would point the run's tools — dispatched with the
 * admin bearer, past the per-shard authorization gate — at another tenant's shard. Only
 * the boundary's own trusted shard is kept (the starting shard DO, the parent run, the
 * scheduler record, the app's `resolveShard` hook); `undefined` means the default shard.
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

export { withRunShard };
