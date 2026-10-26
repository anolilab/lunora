import { LOG_ARCHIVE_PATH, SHARD_TRAFFIC_PATH } from "../client-paths";
import type { PipelineLogPage, ShardTrafficResult } from "../types";
import type { LunoraAdminClient } from "./admin-client";
import type { AdminHost } from "./host";

export const shardTraffic = async (host: AdminHost, table: Parameters<LunoraAdminClient["shardTraffic"]>[0]): ReturnType<LunoraAdminClient["shardTraffic"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SHARD_TRAFFIC_PATH, "POST", { table })) as Partial<ShardTrafficResult>;

    return { failed: body.failed ?? 0, ok: body.ok ?? 0, shards: body.shards ?? [] };
};

export const queryLogArchive = async (
    host: AdminHost,
    query: Parameters<LunoraAdminClient["queryLogArchive"]>[0] = {},
): ReturnType<LunoraAdminClient["queryLogArchive"]> => {
    host.assertOpen();

    // `PipelineLogQuery` is a named interface (no index signature), so widen it
    // to the record shape `adminFetch` serializes.
    const body = (await host.adminFetch(LOG_ARCHIVE_PATH, "POST", query as Record<string, unknown>)) as Partial<PipelineLogPage>;

    return { nextCursor: body.nextCursor, rows: body.rows ?? [] };
};
