import { LOG_ARCHIVE_PATH } from "../client-paths";
import type { PipelineLogPage, PipelineLogQuery } from "../types";
import type { AdminHost } from "./host";

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export const queryLogArchive = async (host: AdminHost, query: PipelineLogQuery = {}): Promise<PipelineLogPage> => {
    host.assertOpen();

    // `PipelineLogQuery` is a named interface (no index signature), so widen it
    // to the record shape `adminFetch` serializes.
    const body = (await host.adminFetch(LOG_ARCHIVE_PATH, "POST", query as Record<string, unknown>)) as Partial<PipelineLogPage>;

    return { nextCursor: body.nextCursor, rows: body.rows ?? [] };
};
