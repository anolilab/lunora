import { SHARD_TRAFFIC_PATH } from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { ShardTrafficResult } from "../types";
import type { AdminHost } from "./host";

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export const shardTraffic = async (host: AdminHost, table: Parameters<LunoraClient["shardTraffic"]>[0]): ReturnType<LunoraClient["shardTraffic"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SHARD_TRAFFIC_PATH, "POST", { table })) as Partial<ShardTrafficResult>;

    return { failed: body.failed ?? 0, ok: body.ok ?? 0, shards: body.shards ?? [] };
};
