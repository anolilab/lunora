/**
 * Entry point for the generated-shard workerd suite. The shard is the codegen golden
 * for `codegen/__tests__/fixtures/random-replay`, so this runs the emitted `ctx.random`
 * wiring and not a hand-written double.
 */
import { createShardDO } from "../../../../codegen/__tests__/fixtures/random-replay/lunora/_generated/shard";

export const RandomShard = createShardDO();

export default {
    fetch: async (): Promise<Response> => new Response("random-replay test worker", { status: 404 }),
};
