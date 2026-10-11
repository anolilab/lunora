import { STORAGE_BUCKETS_PATH, STORAGE_PATH, STORAGE_URL_PATH } from "../client-paths";
import { bucketQuery, withQuery } from "../client-urls";
import type { LunoraClient } from "../lunora-client";
import type { StorageObject } from "../types";
import type { AdminHost } from "./host";

export const listStorageObjects = async (
    host: AdminHost,
    options: Parameters<LunoraClient["listStorageObjects"]>[0] = {},
): ReturnType<LunoraClient["listStorageObjects"]> => {
    host.assertOpen();

    const path = withQuery(STORAGE_PATH, { bucket: options.bucket, cursor: options.cursor, limit: options.limit, prefix: options.prefix });
    const body = (await host.adminFetch(path, "GET")) as { cursor?: string; objects?: StorageObject[] };

    return { cursor: body.cursor, objects: body.objects ?? [] };
};

export const deleteStorageObject = async (
    host: AdminHost,
    key: Parameters<LunoraClient["deleteStorageObject"]>[0],
    options?: Parameters<LunoraClient["deleteStorageObject"]>[1],
): ReturnType<LunoraClient["deleteStorageObject"]> => {
    host.assertOpen();

    const path = `${STORAGE_PATH}?key=${encodeURIComponent(key)}${bucketQuery(options?.bucket)}`;
    const body = (await host.adminFetch(path, "DELETE")) as { deleted?: boolean; key?: string };

    return { deleted: body.deleted === true, key: body.key ?? key };
};

export const listStorageBuckets = async (host: AdminHost): ReturnType<LunoraClient["listStorageBuckets"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(STORAGE_BUCKETS_PATH, "GET")) as { buckets?: string[] };

    return body.buckets ?? [];
};

export const uploadStorageObject = async (
    host: AdminHost,
    options: Parameters<LunoraClient["uploadStorageObject"]>[0],
): ReturnType<LunoraClient["uploadStorageObject"]> => {
    host.assertOpen();

    const path = `${STORAGE_PATH}?key=${encodeURIComponent(options.key)}${bucketQuery(options.bucket)}`;
    const body = (await host.adminFetch(path, "PUT", options.body, options.contentType)) as { etag?: string; key?: string };

    return { etag: body.etag, key: body.key ?? options.key };
};

export const signedStorageUrl = async (
    host: AdminHost,
    key: Parameters<LunoraClient["signedStorageUrl"]>[0],
    options?: Parameters<LunoraClient["signedStorageUrl"]>[1],
): ReturnType<LunoraClient["signedStorageUrl"]> => {
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
