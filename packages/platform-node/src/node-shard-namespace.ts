import { LunoraError } from "@lunora/errors";
import type { DirectShardDirectory } from "@lunora/platform";
import type { ShardNamespaceLike } from "@lunora/runtime";

/**
 * Present the node shard registry as the `ShardNamespaceLike` a worker is built
 * over (`createWorker({ shardDO })`).
 *
 * The registry names its id derivation `idForName`, which is the
 * `ShardDirectory` spelling; the worker reads Cloudflare's `idFromName`. Both
 * return the key itself here, so a stub from either route reaches the same shard.
 */
export const createNodeShardNamespace = (directory: DirectShardDirectory): ShardNamespaceLike => {
    return {
        get: (id) => {
            if (directory.get === undefined) {
                throw new LunoraError("INTERNAL", "@lunora/platform-node: this shard directory has no id-based lookup");
            }

            return directory.get(id);
        },
        getByName: (name) => directory.getByName(name),
        idFromName: (name) => directory.idForName?.(name) ?? name,
    };
};
