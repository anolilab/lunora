/**
 * The `/_lunora/admin/storage*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./auth-admin-routes`). One driver per pathname backing the studio's
 * file browser: list / delete / upload (sharing `/_lunora/admin/storage` by
 * method), a signed-URL minter, and the bucket-name list for the bucket picker.
 *
 * Every handler is closure-free of the worker's internals — it reaches the
 * admin-token gate, the option registry, and the request helpers through the
 * injected {@link StorageAdminRouteDeps}, so this module never imports runtime
 * values from `create-worker` (only its types, erased at build).
 */
import type {
    StorageDeleteFn as StorageDeleteFunction,
    StorageListFn as StorageListFunction,
    StorageSignedUrlFn as StorageSignedUrlFunction,
    StorageUploadFn as StorageUploadFunction,
} from "./create-worker";
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";

const STORAGE_PATH = "/_lunora/admin/storage";
const STORAGE_URL_PATH = "/_lunora/admin/storage/url";
const STORAGE_BUCKETS_PATH = "/_lunora/admin/storage/buckets";

// `@lunora/storage`'s `buildSignedUrl` rejects an `expiresInSeconds` over 7 days;
// mirror that ceiling so an over-max request is clamped, not a 500.
const MAX_STORAGE_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Body budget for an object upload, declared by this route the way the KV value
 * PUT declares its own (`KV_VALUE_MAX_BODY_BYTES`). The shared 1 MiB default is
 * a JSON-request cap; a blob migration (`lunora import --with-storage`) moves
 * real files, and a 1 MiB ceiling would push nearly every photo onto the
 * signed-URL fallback. 32 MiB is what the isolate can buffer and digest
 * comfortably inside the Workers memory limit.
 */
const STORAGE_UPLOAD_MAX_BODY_BYTES: number = 32 * 1_048_576;

/** Methods `/_lunora/admin/storage/url` will sign. Anything else is a 400, not a signed `DELETE`. */
const SIGNABLE_METHODS = new Set(["GET", "PUT"]);

/**
 * Lowercase hex-encode an `ArrayBuffer` — WebCrypto digest output (base16) as
 * the storage importer's `sha256` surface expects it.
 */
const toHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let out = "";

    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
};

/** The worker internals the storage routes reach through injection rather than closure. */
interface StorageAdminRouteDeps {
    /** Admin-token gate (throws 403). Used directly by the buckets route (which has no `requireAdminOption` value to gate). */
    assertAdmin: (request: Request) => void;
    /** Parse the shared `limit` / `offset` paging params. */
    parsePaging: (request: Request) => { limit?: number; offset?: number };
    /** Read a query param, collapsing missing/empty to `undefined`. */
    queryParameter: (url: URL, name: string) => string | undefined;
    /** Read the request body as bytes under the given size limit (defaults to the runtime's shared cap). */
    readBodyBytes: (request: Request, limit?: number) => Promise<ArrayBuffer>;
    /** Admin-gate + require a configured option, else throw the `*_NOT_CONFIGURED` error. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
    /** The storage admin options off `WorkerOptions`. */
    storage: {
        storageBuckets?: string[];
        storageDelete?: StorageDeleteFunction;
        storageList?: StorageListFunction;
        storageSignedUrl?: StorageSignedUrlFunction;
        storageUpload?: StorageUploadFunction;
    };
}

/**
 * Build the `/_lunora/admin/storage*` route map merged into the worker's internal
 * route table.
 */
const buildStorageAdminRoutes = (deps: StorageAdminRouteDeps): Record<string, (request: Request) => Promise<Response> | Response> => {
    const { assertAdmin, parsePaging, queryParameter, readBodyBytes, requireAdminOption, storage } = deps;

    /** Read a required `key` off the request URL or throw a 400. */
    const requireStorageKey = (url: URL): string => {
        const key = queryParameter(url, "key");

        if (key === undefined) {
            throw new LunoraError("Storage endpoint requires a `key` query parameter", { code: "BAD_REQUEST", status: 400 });
        }

        return key;
    };

    const handleStorageList = async (request: Request): Promise<Response> => {
        const storageList = requireAdminOption(request, storage.storageList, {
            code: "STORAGE_NOT_CONFIGURED",
            message: "storage endpoint requires a `storageList` function on the worker",
        });

        const url = new URL(request.url);
        const result = await storageList(queryParameter(url, "prefix"), {
            bucket: queryParameter(url, "bucket"),
            cursor: queryParameter(url, "cursor"),
            ...parsePaging(request),
        });

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleStorageBuckets = (request: Request): Response => {
        assertMethod(request, "GET", "Storage-buckets");

        assertAdmin(request);

        // Always 200 (even with no buckets configured) so the studio simply hides
        // the picker rather than treating absence as an error.
        return Response.json({ buckets: storage.storageBuckets ?? [] }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleStorageDelete = async (request: Request): Promise<Response> => {
        const storageDelete = requireAdminOption(request, storage.storageDelete, {
            code: "STORAGE_DELETE_NOT_CONFIGURED",
            message: "storage delete requires a `storageDelete` function on the worker",
        });

        const url = new URL(request.url);
        const key = requireStorageKey(url);

        await storageDelete(key, { bucket: queryParameter(url, "bucket") });

        return Response.json({ deleted: true, key }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleStorageUpload = async (request: Request): Promise<Response> => {
        const storageUpload = requireAdminOption(request, storage.storageUpload, {
            code: "STORAGE_UPLOAD_NOT_CONFIGURED",
            message: "storage upload requires a `storageUpload` function on the worker",
        });

        const url = new URL(request.url);
        const key = requireStorageKey(url);
        // The entry-point `Content-Length` guard already rejects an oversized
        // declared length for PUT; reading the buffer here is the authoritative
        // size check the runtime owns (R2 enforces its own ceilings downstream).
        const body = await readBodyBytes(request, STORAGE_UPLOAD_MAX_BODY_BYTES);
        const headerContentType = request.headers.get("content-type");
        const contentType = headerContentType === null || headerContentType === "" ? undefined : headerContentType;

        // Optional upload verification: the caller declares the exact byte size
        // and/or SHA-256 (base16) of what it is sending. When either is present
        // the worker hashes the body and rejects with `STORAGE_CHECKSUM_MISMATCH`
        // BEFORE anything is written, so a corrupt or truncated transfer fails
        // closed instead of persisting unverified bytes. Absent both, the
        // endpoint behaves exactly as before (legacy uploads).
        const expectedSha256 = queryParameter(url, "expectedSha256");
        const expectedSize = queryParameter(url, "expectedSize");
        let sha256: string | undefined;

        if (expectedSha256 !== undefined || expectedSize !== undefined) {
            const digest = await crypto.subtle.digest("SHA-256", body);
            sha256 = toHex(digest);

            const sizeMismatch = expectedSize !== undefined && body.byteLength !== Number(expectedSize);
            const hashMismatch = expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase();

            if (sizeMismatch || hashMismatch) {
                throw new LunoraError("Upload failed verification — the body did not match the declared size or SHA-256 checksum, so nothing was written", {
                    code: "STORAGE_CHECKSUM_MISMATCH",
                    status: 400,
                });
            }
        }

        const result = await storageUpload(key, body, { bucket: queryParameter(url, "bucket"), contentType });

        // Echo the computed hash only when verification was requested — the
        // importer uses it to confirm the blob landed byte-identical.
        return Response.json(sha256 === undefined ? result : { ...result, sha256 }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    /**
     * Dispatch the storage endpoint by method so `GET` (list), `PUT`/`POST`
     * (upload), and `DELETE` (delete) share one pathname.
     */
    const handleStorage = async (request: Request): Promise<Response> => {
        switch (request.method) {
            case "DELETE": {
                return handleStorageDelete(request);
            }
            case "GET": {
                return handleStorageList(request);
            }
            case "POST":
            case "PUT": {
                return handleStorageUpload(request);
            }
            default: {
                throw new LunoraError("Storage endpoint requires GET, PUT, POST, or DELETE", { code: "METHOD_NOT_ALLOWED", status: 405 });
            }
        }
    };

    const handleStorageSignedUrl = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Storage URL");

        const storageSignedUrl = requireAdminOption(request, storage.storageSignedUrl, {
            code: "STORAGE_URL_NOT_CONFIGURED",
            message: "storage URL endpoint requires a `storageSignedUrl` function on the worker",
        });

        const url = new URL(request.url);
        const key = requireStorageKey(url);
        // Optional share-link lifetime; a non-numeric/absent value leaves the host's
        // default. `@lunora/storage`'s `buildSignedUrl` THROWS above its 7-day max,
        // so clamp here to keep an over-max request a valid URL rather than a 500.
        const expiresInRaw = Number(queryParameter(url, "expiresIn") ?? "");
        const expiresInSeconds = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Math.min(expiresInRaw, MAX_STORAGE_EXPIRES_IN_SECONDS) : undefined;
        // Optional HTTP method for the presigned URL — the importer uses `PUT` for
        // large blobs that exceed the worker's body-size cap. Validated against an
        // allowlist rather than cast: the value is caller-supplied and
        // `buildSignedUrl` signs whatever method string it is handed, so an
        // unchecked `?method=DELETE` would mint a signed destructive URL.
        const methodRaw = queryParameter(url, "method");

        if (methodRaw !== undefined && !SIGNABLE_METHODS.has(methodRaw)) {
            throw new LunoraError("Storage URL `method` must be GET or PUT", { code: "BAD_REQUEST", status: 400 });
        }

        const method = methodRaw as "GET" | "PUT" | undefined;
        const contentType = queryParameter(url, "contentType");
        const signedUrl = await storageSignedUrl(key, { bucket: queryParameter(url, "bucket"), contentType, expiresInSeconds, method });

        return Response.json({ key, url: signedUrl }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return {
        [STORAGE_BUCKETS_PATH]: handleStorageBuckets,
        [STORAGE_PATH]: handleStorage,
        [STORAGE_URL_PATH]: handleStorageSignedUrl,
    };
};

export type { StorageAdminRouteDeps };
export { buildStorageAdminRoutes, STORAGE_BUCKETS_PATH, STORAGE_PATH, STORAGE_UPLOAD_MAX_BODY_BYTES, STORAGE_URL_PATH };
