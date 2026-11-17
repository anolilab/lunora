import { LunoraError } from "@lunora/errors";

import type { AgentInboundShardResolver } from "./types";

/**
 * Run the app's inbound shard hook. A value that is not a non-empty string is refused
 * rather than read as "no shard": a hook that meant to name a tenant and returned junk
 * would otherwise run that tenant's message against the default shard.
 */
const resolveInboundShard = async <Message>(
    resolver: AgentInboundShardResolver<Message> | undefined,
    message: Message,
    label: string,
): Promise<string | undefined> => {
    if (resolver === undefined) {
        return undefined;
    }

    const shardKey: unknown = await resolver(message);

    if (shardKey === undefined) {
        return undefined;
    }

    if (typeof shardKey !== "string" || shardKey.length === 0) {
        throw new LunoraError("INTERNAL", `@lunora/agent: \`${label}\` must return a non-empty shard key or undefined`);
    }

    return shardKey;
};

export default resolveInboundShard;
