import { LOG_ARCHIVE_PATH, SHARD_TRAFFIC_PATH } from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { PipelineLogPage, ShardTrafficResult } from "../types";
import type { AdminHost } from "./host";

export const shardTraffic = async (host: AdminHost, table: Parameters<LunoraClient["shardTraffic"]>[0]): ReturnType<LunoraClient["shardTraffic"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SHARD_TRAFFIC_PATH, "POST", { table })) as Partial<ShardTrafficResult>;

    return { failed: body.failed ?? 0, ok: body.ok ?? 0, shards: body.shards ?? [] };
};

export const queryLogArchive = async (
    host: AdminHost,
    query: Parameters<LunoraClient["queryLogArchive"]>[0] = {},
): ReturnType<LunoraClient["queryLogArchive"]> => {
    host.assertOpen();

    // `PipelineLogQuery` is a named interface (no index signature), so widen it
    // to the record shape `adminFetch` serializes.
    const body = (await host.adminFetch(LOG_ARCHIVE_PATH, "POST", query as Record<string, unknown>)) as Partial<PipelineLogPage>;

    return { nextCursor: body.nextCursor, rows: body.rows ?? [] };
};
