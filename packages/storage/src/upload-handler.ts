/**
 * RLS-gated, **non-admin** resumable upload handler.
 *
 * The admin studio upload path (`storageUpload` → `/_lunora/admin/storage`) is
 * gated by an `adminToken` — fine for the file browser, wrong for end-user
 * uploads. This module gives end-user browsers a real upload story (live
 * progress, pause/resume, large-file resumable, per-part retry) by mounting
 * `@visulima/storage`'s resumable upload handlers (TUS / chunked-REST /
 * multipart-form) behind an app-supplied **RLS** gate instead of an admin token.
 *
 * The wire protocol is spoken end-to-end with `@visulima/storage-client`
 * (`useUpload` / `createTusAdapter` …) — Lunora does not hand-roll the uploader.
 * Point the client's endpoint at the route the app mounts this handler on; the
 * bytes flow through the Worker → the configured provider (R2 in production via
 * {@link createR2UploadStorage}, an in-memory provider in tests).
 *
 * The `authorize` callback is the RLS decision: it runs before every request
 * (create, chunk PATCH, resume HEAD, delete) and denies fail-closed — a thrown
 * callback is a deny, never a 500.
 */
import { Multipart, Rest, Tus } from "@visulima/storage/handler/http/fetch";
import { AwsLightStorage } from "@visulima/storage/provider/aws-light";

/** Resumable upload wire protocols the handler can speak. */
type UploadProtocol = "chunked-rest" | "multipart" | "tus";

// Derive the visulima handler option/storage types from the class constructors
// so we never import `@visulima/storage`'s internal `BaseStorage` / `UploadFile`
// symbols (they are not part of the fetch-handler entry's public surface).
type UploadHandlerOptions = ConstructorParameters<typeof Tus>[0];

/** A `@visulima/storage` storage provider (e.g. {@link createR2UploadStorage} or a memory provider in tests). */
type UploadStorage = UploadHandlerOptions["storage"];

/**
 * The context handed to {@link CreateUploadHandlerOptions.authorize}. Everything
 * needed to make an RLS decision: the raw `request` (headers/cookies/auth), the
 * `method`, the parsed `url`, and which `protocol` the handler speaks.
 */
interface UploadAuthzContext {
    /** The upload method being invoked (`POST` create, `PATCH` chunk, `HEAD` resume, `DELETE`). */
    method: string;
    /** The protocol this handler is mounted for. */
    protocol: UploadProtocol;
    /** The inbound request — inspect headers/cookies to resolve the caller's identity. */
    request: Request;
    /** The parsed request URL (query params, upload-id path segment). */
    url: URL;
}

/** Options for {@link createUploadHandler}. */
interface CreateUploadHandlerOptions {
    /**
     * The RLS gate. Runs before every upload request and denies fail-closed:
     * returning `false` **or throwing** yields a `403`. Omit only for a fully
     * public bucket — the whole point of this handler over the admin path is
     * that uploads are gated by *your* per-user policy, not an admin token.
     */
    authorize?: (context: UploadAuthzContext) => boolean | Promise<boolean>;
    /** Maximum accepted file size in bytes (forwarded to the multipart parser). */
    maxFileSize?: number;
    /** Which protocol to speak. Default `"tus"` (the resumable, pause/resume-capable one). */
    protocol?: UploadProtocol;
    /** The storage provider the bytes land in (R2 in prod, memory in tests). */
    storage: UploadStorage;
}

/** The object returned by {@link createUploadHandler}. */
interface UploadHandler {
    /**
     * Handle one upload request. Runs the RLS gate, then delegates to the
     * `@visulima/storage` protocol handler. Wire this into your Worker's routing
     * for the path the client uploads to.
     */
    fetch: (request: Request) => Promise<Response>;
    /** The protocol this handler speaks. */
    protocol: UploadProtocol;
}

/** R2 (S3-compatible) credentials + bucket for {@link createR2UploadStorage}. */
interface R2UploadStorageOptions {
    /** R2 S3 API Access Key ID (from an R2 API token). */
    accessKeyId: string;
    /** Cloudflare account id — used to derive the R2 S3 endpoint host. */
    accountId: string;
    /** Target R2 bucket name. */
    bucket: string;

    /**
     * Explicit R2 S3 endpoint. Defaults to
     * `https://&lt;accountId>.r2.cloudflarestorage.com`. Pass this to pin a
     * jurisdiction (e.g. `&lt;accountId>.eu.r2.cloudflarestorage.com`).
     */
    endpoint?: string;
    /** Client-side multipart part size (bytes or a size string like `"16MB"`). */
    partSize?: number | string;

    /**
     * Path prefix the handler is mounted on (must match the client endpoint's
     * path). Default `"/"`.
     */
    path?: string;
}

// TUS requires `Tus-Resumable` on *every* response, denials included, or a
// spec-compliant client treats the response as a protocol error rather than an
// auth failure. The error body mirrors visulima's `ApiError` shape so
// `@visulima/storage-client`'s `UploadError` surfaces `status` + `code`.
const TUS_RESUMABLE = "1.0.0";

const denyResponse = (protocol: UploadProtocol): Response => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (protocol === "tus") {
        headers["Tus-Resumable"] = TUS_RESUMABLE;
    }

    return Response.json({ error: { code: "FORBIDDEN", message: "Upload denied by authorization policy", name: "ForbiddenError" } }, { headers, status: 403 });
};

const instantiateHandler = (protocol: UploadProtocol, handlerOptions: UploadHandlerOptions): { fetch: (request: Request) => Promise<Response> } => {
    if (protocol === "chunked-rest") {
        return new Rest(handlerOptions);
    }

    if (protocol === "multipart") {
        return new Multipart(handlerOptions);
    }

    return new Tus(handlerOptions);
};

/**
 * Build an RLS-gated resumable upload handler over a `@visulima/storage`
 * provider. Mount its {@link UploadHandler.fetch} on the route your client
 * uploads to and drive it with `@visulima/storage-client`.
 */
const createUploadHandler = (options: CreateUploadHandlerOptions): UploadHandler => {
    const protocol = options.protocol ?? "tus";

    const handlerOptions: UploadHandlerOptions = {
        storage: options.storage,
        ...(options.maxFileSize === undefined ? {} : { maxFileSize: options.maxFileSize }),
    };

    const handler = instantiateHandler(protocol, handlerOptions);

    const { authorize } = options;

    const fetch = async (request: Request): Promise<Response> => {
        if (authorize !== undefined) {
            try {
                const allowed = await authorize({ method: request.method, protocol, request, url: new URL(request.url) });

                if (!allowed) {
                    return denyResponse(protocol);
                }
            } catch {
                // A throwing RLS callback is a denial, never a 500 — fail closed.
                return denyResponse(protocol);
            }
        }

        return handler.fetch(request);
    };

    return { fetch, protocol };
};

/**
 * Build an R2-backed storage provider for {@link createUploadHandler} using
 * `@visulima/storage`'s dependency-light `aws-light` provider (`aws4fetch`, no
 * AWS SDK). R2's S3 region alias is always `auto`.
 *
 * Requires an R2 **S3 API** token's Access Key ID / Secret Access Key — the
 * same credential shape `@lunora/storage`'s presigned-URL helpers take. In a
 * Worker the `aws-light` provider needs `nodejs_compat` (it imports
 * `node:stream`).
 */
const createR2UploadStorage = (options: R2UploadStorageOptions & { secretAccessKey: string }): AwsLightStorage =>
    new AwsLightStorage({
        accessKeyId: options.accessKeyId,
        bucket: options.bucket,
        endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
        path: options.path ?? "/",
        region: "auto",
        secretAccessKey: options.secretAccessKey,
        ...(options.partSize === undefined ? {} : { partSize: options.partSize }),
    });

export type { CreateUploadHandlerOptions, R2UploadStorageOptions, UploadAuthzContext, UploadHandler, UploadProtocol, UploadStorage };
export { createR2UploadStorage, createUploadHandler };
