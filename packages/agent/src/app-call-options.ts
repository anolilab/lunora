import type { AgentRunOptions } from "./types";

/**
 * Dispatch options for a call into the APP's functions (a `functionTool` target, a memory
 * source): they follow the run's shard, where the tenant's `.shardBy(...)` rows live. The
 * agent's own `agents:*` calls never use this; its threads and secrets are on the default shard.
 */
const appCallOptions = (shardKey: string | undefined): AgentRunOptions | undefined => (shardKey === undefined ? undefined : { shardKey });

export default appCallOptions;
