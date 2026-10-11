import { decodeWire, encodeWire } from "../../../../shared/wire-codec";
import { GLOBAL_FACET_PATH, GLOBAL_TABLE_PATH, GLOBAL_TABLES_PATH } from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { GlobalFacetResult, GlobalTableInfo, GlobalTablePage } from "../types";
import type { AdminHost } from "./host";

export const listGlobalTables = async (host: AdminHost): ReturnType<LunoraClient["listGlobalTables"]> => {
    host.assertOpen();

    return (await host.adminFetch(GLOBAL_TABLES_PATH, "GET")) as GlobalTableInfo[];
};

export const readGlobalTablePage = async (
    host: AdminHost,
    options: Parameters<LunoraClient["readGlobalTablePage"]>[0],
): ReturnType<LunoraClient["readGlobalTablePage"]> => {
    host.assertOpen();

    const params = new URLSearchParams({ table: options.table });

    if (options.limit !== undefined) {
        params.set("limit", String(options.limit));
    }

    if (options.offset !== undefined) {
        params.set("offset", String(options.offset));
    }

    if (options.filters !== undefined && options.filters.length > 0) {
        params.set("filters", JSON.stringify(encodeWire(options.filters)));
    }

    return decodeWire(await host.adminFetch(`${GLOBAL_TABLE_PATH}?${params.toString()}`, "GET")) as GlobalTablePage;
};

export const facetGlobalColumn = async (
    host: AdminHost,
    options: Parameters<LunoraClient["facetGlobalColumn"]>[0],
): ReturnType<LunoraClient["facetGlobalColumn"]> => {
    host.assertOpen();

    const params = new URLSearchParams({ column: options.column, table: options.table });

    if (options.limit !== undefined) {
        params.set("limit", String(options.limit));
    }

    if (options.filters !== undefined && options.filters.length > 0) {
        params.set("filters", JSON.stringify(encodeWire(options.filters)));
    }

    return decodeWire(await host.adminFetch(`${GLOBAL_FACET_PATH}?${params.toString()}`, "GET")) as GlobalFacetResult;
};
