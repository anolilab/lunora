import { KV_KEYS_PATH, KV_NAMESPACES_PATH, KV_VALUE_PATH } from "../client-paths";
import { withQuery } from "../client-urls";
import type { KvKeyListResult, KvNamespaceSummary, KvValueResult } from "../types";
import type { LunoraAdminClient } from "./admin-client";
import type { AdminHost } from "./host";

export const listKvNamespaces = async (host: AdminHost): ReturnType<LunoraAdminClient["listKvNamespaces"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(KV_NAMESPACES_PATH, "GET")) as { namespaces?: KvNamespaceSummary[] };

    return body.namespaces ?? [];
};

export const listKvKeys = async (host: AdminHost, options: Parameters<LunoraAdminClient["listKvKeys"]>[0]): ReturnType<LunoraAdminClient["listKvKeys"]> => {
    host.assertOpen();

    const path = withQuery(KV_KEYS_PATH, {
        cursor: options.cursor,
        limit: options.limit,
        namespace: options.namespace,
        prefix: options.prefix,
    });

    return (await host.adminFetch(path, "GET")) as KvKeyListResult;
};

export const getKvValue = async (host: AdminHost, options: Parameters<LunoraAdminClient["getKvValue"]>[0]): ReturnType<LunoraAdminClient["getKvValue"]> => {
    host.assertOpen();

    const path = withQuery(KV_VALUE_PATH, { key: options.key, namespace: options.namespace });

    return (await host.adminFetch(path, "GET")) as KvValueResult;
};

export const putKvValue = async (host: AdminHost, options: Parameters<LunoraAdminClient["putKvValue"]>[0]): ReturnType<LunoraAdminClient["putKvValue"]> => {
    host.assertOpen();

    await host.adminFetch(KV_VALUE_PATH, "PUT", options);
};

export const deleteKvKey = async (host: AdminHost, options: Parameters<LunoraAdminClient["deleteKvKey"]>[0]): ReturnType<LunoraAdminClient["deleteKvKey"]> => {
    host.assertOpen();

    const path = withQuery(KV_VALUE_PATH, { key: options.key, namespace: options.namespace });

    await host.adminFetch(path, "DELETE");
};
