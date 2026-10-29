import { STORAGE_BUCKETS_PATH, STORAGE_PATH, STORAGE_URL_PATH } from "../client-paths";
import { bucketQuery, withQuery } from "../client-urls";
import type { StorageObject } from "../types";
import type { LunoraAdminClient } from "./admin-client";
import type { AdminHost } from "./host";

export const listStorageObjects = async (
    host: AdminHost,
    options: Parameters<LunoraAdminClient["listStorageObjects"]>[0] = {},
): ReturnType<LunoraAdminClient["listStorageObjects"]> => {
    host.assertOpen();

    const path = withQuery(STORAGE_PATH, { bucket: options.bucket, cursor: options.cursor, limit: options.limit, prefix: options.prefix });
    const body = (await host.adminFetch(path, "GET")) as { cursor?: string; objects?: StorageObject[] };

    return { cursor: body.cursor, objects: body.objects ?? [] };
};

export const deleteStorageObject = async (
    host: AdminHost,
    key: Parameters<LunoraAdminClient["deleteStorageObject"]>[0],
    options?: Parameters<LunoraAdminClient["deleteStorageObject"]>[1],
): ReturnType<LunoraAdminClient["deleteStorageObject"]> => {
    host.assertOpen();

    const path = `${STORAGE_PATH}?key=${encodeURIComponent(key)}${bucketQuery(options?.bucket)}`;
    const body = (await host.adminFetch(path, "DELETE")) as { deleted?: boolean; key?: string };

    return { deleted: body.deleted === true, key: body.key ?? key };
};

export const listStorageBuckets = async (host: AdminHost): ReturnType<LunoraAdminClient["listStorageBuckets"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(STORAGE_BUCKETS_PATH, "GET")) as { buckets?: string[] };

    return body.buckets ?? [];
};

export const uploadStorageObject = async (
    host: AdminHost,
    options: Parameters<LunoraAdminClient["uploadStorageObject"]>[0],
): ReturnType<LunoraAdminClient["uploadStorageObject"]> => {
    host.assertOpen();

    const path = `${STORAGE_PATH}?key=${encodeURIComponent(options.key)}${bucketQuery(options.bucket)}`;
    const body = (await host.adminFetch(path, "PUT", options.body, options.contentType)) as { etag?: string; key?: string };

    return { etag: body.etag, key: body.key ?? options.key };
};

export const signedStorageUrl = async (
    host: AdminHost,
    key: Parameters<LunoraAdminClient["signedStorageUrl"]>[0],
    options?: Parameters<LunoraAdminClient["signedStorageUrl"]>[1],
): ReturnType<LunoraAdminClient["signedStorageUrl"]> => {
    host.assertOpen();

    const expiresInSeconds = options?.expiresInSeconds;
    const expiryQuery = expiresInSeconds === undefined ? "" : `&expiresIn=${encodeURIComponent(expiresInSeconds.toString())}`;
    const path = `${STORAGE_URL_PATH}?key=${encodeURIComponent(key)}${expiryQuery}${bucketQuery(options?.bucket)}`;
    const body = (await host.adminFetch(path, "GET")) as { url?: string };

    if (typeof body.url !== "string") {
        throw new TypeError("LunoraClient: storage URL endpoint returned no `url`");
    }

    return body.url;
};
