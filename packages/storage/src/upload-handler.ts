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
 * bytes flow through the Worker → the configured provider (R2 through the
 * Worker's binding via `createR2BindingUploadStorage`, R2's S3 API via
 * {@link createR2UploadStorage}, an in-memory provider in tests).
 *
 * The `authorize` callback is the RLS decision: it runs before every request
 * (create, chunk PATCH, resume HEAD, delete) and denies fail-closed — a thrown
 * callback is a deny, never a 500. For TUS and chunked REST, a request declaring
 * a size over `maxFileSize` is refused (413) before it reaches the gate. A
 * finished upload cannot be deleted through the handler: TUS refuses to
 * terminate one, and the other protocols refuse `DELETE` outright (405).
 */
import { LunoraError } from "@lunora/errors";
import { File } from "@visulima/storage";
import { Multipart, Rest, Tus } from "@visulima/storage/handler/http/fetch";
import { AwsLightStorage } from "@visulima/storage/provider/aws-light";

/** Resumable upload wire protocols the handler can speak. */
type UploadProtocol = "chunked-rest" | "multipart" | "tus";

/**
 * Default ceiling applied to `maxFileSize` when the caller doesn't supply one
 * (100 MiB). Without SOME cap, an unauthenticated or loosely-authorized
 * handler accepts an unbounded request body — pass an explicit `maxFileSize`
 * to raise or lower this for your app.
 */
const DEFAULT_MAX_UPLOAD_BYTES: number = 100 * 1024 * 1024;

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

/**
 * The context handed to {@link CreateUploadHandlerOptions.maxFileSizeFor}: the
 * authorization context plus what the create request declares about the file.
 * Everything here comes from the client, so it caps an upload by what the
 * client SAYS it is; `allowMIME` on the provider is what checks the type.
 */
interface UploadSizeContext extends UploadAuthzContext {
    /**
     * The declared MIME type, resolved the way the stored file's type is: on
     * chunked REST the request's `Content-Type`; on TUS the `Upload-Metadata`
     * `mimeType`, else `type`, else `filetype`; else
     * `application/octet-stream`.
     */
    contentType: string;

    /**
     * The largest size the request declares (`Upload-Length`, `X-Total-Size`,
     * `Content-Length`). A declared size that is not a non-negative integer
     * reads as `Infinity`.
     */
    declaredSize: number | undefined;
    /** The decoded TUS `Upload-Metadata`, or the chunked-REST `X-File-Metadata` JSON, as strings. */
    metadata: Record<string, string>;
}

/** Options for {@link createUploadHandler}. */
interface CreateUploadHandlerOptions {
    /**
     * The RLS gate. Runs before every upload request and denies fail-closed:
     * returning `false` **or throwing** yields a `403`. Omit only for a fully
     * public bucket — the whole point of this handler over the admin path is
     * that uploads are gated by *your* per-user policy, not an admin token.
     *
     * Omitting it mounts an unauthenticated, unbounded-write endpoint, so
     * doing so logs a one-time warning (per handler) unless `silent`/`public`
     * says the omission is intentional.
     */
    authorize?: (context: UploadAuthzContext) => boolean | Promise<boolean>;

    /**
     * Maximum accepted file size in bytes. Forwarded to the multipart parser
     * (protocol `"multipart"`) and, for `"tus"`/`"chunked-rest"`, enforced by
     * this handler itself against the largest size the request declares across
     * `Upload-Length` (TUS), `X-Total-Size` (chunked REST) and `Content-Length`
     * — see {@link declaredUploadSize}. Defaults to
     * {@link DEFAULT_MAX_UPLOAD_BYTES} (100 MiB) — pass this to raise or lower
     * the ceiling; there is no unbounded option. Must be a finite, non-negative
     * number: anything else (notably a `NaN` from an unset env var) throws at
     * construction rather than disabling the cap.
     */
    maxFileSize?: number;

    /**
     * A per-upload size cap, below `maxFileSize`: return the most bytes this
     * upload may hold (say 10 MiB for `image/*`, 2 GiB for `video/*`), or
     * `undefined` to leave `maxFileSize` as the only cap. It can only lower the
     * cap, never raise it past `maxFileSize`.
     *
     * Runs after `authorize`, on the requests that create an upload (`POST`,
     * and the chunked-REST `PUT`) of the `"tus"` and `"chunked-rest"`
     * protocols; later chunks are bounded by the size declared at creation.
     * Not applied to `"multipart"`, whose size is only known once the form is
     * parsed. A create that declares no size is refused (`413`) when this
     * returns a cap, since there is nothing to check it against. Throwing, or
     * returning something that is not a finite, non-negative number, denies the
     * request (`403`), fail-closed like `authorize`.
     */
    maxFileSizeFor?: (context: UploadSizeContext) => number | undefined | Promise<number | undefined>;
    /** Which protocol to speak. Default `"tus"` (the resumable, pause/resume-capable one). */
    protocol?: UploadProtocol;

    /**
     * Set when omitting `authorize` is intentional (a fully public upload
     * bucket) — suppresses the one-time "no authorize gate" warning that would
     * otherwise print when the handler is constructed. Has no effect when
     * `authorize` is provided.
     */
    public?: boolean;

    /** Suppress the one-time default-open-authorize warning. Alias of `public`. */
    silent?: boolean;
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
     * `https://<accountId>.r2.cloudflarestorage.com`. Pass this to pin a
     * jurisdiction (e.g. `<accountId>.eu.r2.cloudflarestorage.com`).
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

const errorResponse = (protocol: UploadProtocol, status: number, error: { code: string; message: string; name: string }): Response => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (protocol === "tus") {
        headers["Tus-Resumable"] = TUS_RESUMABLE;
    }

    return Response.json({ error }, { headers, status });
};

const denyResponse = (protocol: UploadProtocol): Response =>
    errorResponse(protocol, 403, { code: "FORBIDDEN", message: "Upload denied by authorization policy", name: "ForbiddenError" });

const tooLargeResponse = (protocol: UploadProtocol): Response =>
    errorResponse(protocol, 413, {
        code: "REQUEST_ENTITY_TOO_LARGE",
        message: "Upload exceeds the configured maxFileSize",
        name: "RequestEntityTooLargeError",
    });

/**
 * `DELETE` on the chunked-REST and multipart handlers removes any stored file by
 * id (chunked REST also in batches, via `?ids=`), and neither honors
 * `disableTerminationForFinishedUploads` — only TUS does. Refused for them here,
 * so the upload route can only add files; deleting one stays `ctx.storage.delete`.
 */
const methodNotAllowedResponse = (protocol: UploadProtocol): Response => {
    const response = errorResponse(protocol, 405, {
        code: "METHOD_NOT_ALLOWED",
        message: "DELETE is not allowed on this upload route",
        name: "MethodNotAllowedError",
    });

    response.headers.set("Allow", protocol === "multipart" ? "GET, OPTIONS, POST" : "GET, HEAD, OPTIONS, PATCH, POST, PUT");

    return response;
};

/**
 * Best-effort declared upload size read off the request, checked against
 * `maxFileSize` before the request reaches the underlying protocol handler.
 *
 * Why not lean on `@visulima/storage` itself? Its `UploadOptions.maxFileSize`
 * only bounds the multipart-form parser (protocol `"multipart"`); the
 * `"tus"`/`"chunked-rest"` protocols instead validate against the storage
 * provider's own `maxUploadSize` — captured into a validator closure once, at
 * STORAGE construction time. `createUploadHandler` receives an
 * already-constructed `storage`, so it cannot tighten that cap after the
 * fact; this pre-check is what actually enforces `maxFileSize` for those two
 * protocols.
 *
 * Each protocol declares the total in its own header, so all three are read and
 * the LARGEST is checked. TUS's create (`POST`) uses `Upload-Length`. A chunked
 * REST create sends `X-Chunked-Upload: true` with the total in `X-Total-Size`
 * and a zero (or absent) `Content-Length`, since the create carries no body —
 * reading `Content-Length` alone let every chunked-REST upload past the cap.
 * Single-shot REST requests carry the size in `Content-Length`. Taking the
 * largest rather than the first present means a request that declares a small
 * total beside a large body cannot pick the lenient header.
 *
 * Deliberately skipped for `"multipart"`: there, `Content-Length` covers the
 * whole multipart body (boundaries + field headers, not just file bytes), so
 * comparing it to `maxFileSize` would false-reject a file that's actually
 * within the cap — the library's own accurate `maxFileSize` forwarding
 * already covers that protocol.
 *
 * Known gap: a TUS upload created with `Upload-Defer-Length` (no declared
 * total up front) is not covered by this pre-check.
 */
/** A declared size: decimal digits only, as TUS and HTTP define it. */
const DIGITS = /^\d+$/u;

const declaredUploadSize = (request: Request, protocol: UploadProtocol): number | undefined => {
    if (protocol === "multipart") {
        return undefined;
    }

    let largest: number | undefined;

    // `Headers.get` matches case-insensitively, so the casing here is cosmetic.
    for (const header of ["Upload-Length", "X-Total-Size", "Content-Length"]) {
        const raw = request.headers.get(header);

        if (raw === null) {
            continue;
        }

        // A size has to be a non-negative integer. Anything else is read as
        // "too large", never as small: `Upload-Length: -1` once slipped past
        // every cap, because the provider then saw no size at all and let the
        // first PATCH complete an upload of any length.
        const parsed = DIGITS.test(raw.trim()) ? Number(raw) : Number.NaN;
        const size = Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;

        if (largest === undefined || size > largest) {
            largest = size;
        }
    }

    return largest;
};

/**
 * TUS `Upload-Metadata`, decoded exactly as `@visulima/storage`'s TUS handler
 * decodes it: `key base64value,key2 base64value2`, a key may carry no value,
 * and the value is decoded with `Buffer` (which also takes url-safe base64).
 */
const tusMetadata = (header: string): Record<string, string> => {
    const metadata: Record<string, string> = {};

    for (const [key, value] of header.split(",").map((pair) => pair.split(" "))) {
        if (key !== undefined && key !== "") {
            metadata[key] = value === undefined || value === "" ? "" : Buffer.from(value, "base64").toString();
        }
    }

    return metadata;
};

/** Chunked-REST `X-File-Metadata`: a JSON object, as `@visulima/storage` reads it. Malformed metadata declares nothing. */
const restMetadata = (header: string | null): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(header ?? "{}");

        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

/**
 * What a create request declares about its file. The MIME type is resolved by
 * building the same `File` the protocol handler builds, so the cap is decided
 * on the type that is then stored: on chunked REST the request's
 * `Content-Type`, on TUS the metadata's `mimeType`, then `type`, then
 * `filetype`.
 */
const declaredFile = (request: Request, protocol: UploadProtocol): { contentType: string; metadata: Record<string, string> } => {
    const metadata = protocol === "tus" ? tusMetadata(request.headers.get("Upload-Metadata") ?? "") : restMetadata(request.headers.get("X-File-Metadata"));
    const header = request.headers.get("Content-Type");
    // An empty header falls back too, as it does in the REST handler.
    const restType = header === null || header === "" ? "application/octet-stream" : header;
    const contentType = protocol === "tus" ? undefined : restType;
    const file = new File({ contentType, metadata });
    const strings: Record<string, string> = {};

    for (const [key, value] of Object.entries(metadata)) {
        strings[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

    return { contentType: file.contentType, metadata: strings };
};

/** A request that creates an upload: the ones whose declared size a per-upload cap can check. */
const isCreateRequest = (request: Request, protocol: UploadProtocol): boolean =>
    protocol !== "multipart" && (request.method === "POST" || request.method === "PUT");

/**
 * Apply {@link CreateUploadHandlerOptions.maxFileSizeFor} to a create request.
 * Returns the response that refuses it, or `undefined` to let it through.
 */
const checkSizeFor = async (
    maxFileSizeFor: NonNullable<CreateUploadHandlerOptions["maxFileSizeFor"]>,
    context: UploadAuthzContext,
    maxFileSize: number,
): Promise<Response | undefined> => {
    const declaredSize = declaredUploadSize(context.request, context.protocol);
    let cap: unknown;

    try {
        cap = await maxFileSizeFor({ ...context, ...declaredFile(context.request, context.protocol), declaredSize });
    } catch {
        return denyResponse(context.protocol);
    }

    if (cap === undefined) {
        return undefined;
    }

    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
        return denyResponse(context.protocol);
    }

    return declaredSize === undefined || declaredSize > Math.min(cap, maxFileSize) ? tooLargeResponse(context.protocol) : undefined;
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
    const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_UPLOAD_BYTES;

    // `??` only fills in a nullish value, so an unset upload-limit env var
    // coerced with `Number(...)` survives as `NaN` — and `declaredSize > NaN` is
    // always false, which silently removes the ONLY cap this handler enforces
    // for the TUS and chunked-REST protocols. A negative cap is the opposite
    // failure (every upload rejected). Both are configuration bugs, caught at
    // construction rather than acted on per request, mirroring the same guard on
    // `UploadOptions.maxSize` in `createStorage`.
    if (!Number.isFinite(maxFileSize) || maxFileSize < 0) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: maxFileSize must be a finite, non-negative number (received ${String(maxFileSize)})`);
    }

    const handlerOptions: UploadHandlerOptions = {
        // A finished upload is a stored file; removing it is the app's call
        // (`ctx.storage.delete`), not a `DELETE` any caller the upload gate
        // admits can send to the upload route.
        disableTerminationForFinishedUploads: true,
        maxFileSize,
        storage: options.storage,
    };

    const handler = instantiateHandler(protocol, handlerOptions);

    const { authorize, maxFileSizeFor } = options;

    if (authorize === undefined && !options.silent && !options.public) {
        // One-time warning per handler instance — mirrors `@lunora/notify`'s
        // one-time unsafe-default warn (`packages/notify/src/notify.ts`).
        // eslint-disable-next-line no-console -- one-time misconfiguration warning, mirrors other unsafe-default fallbacks
        console.warn(
            "@lunora/storage: createUploadHandler() has no `authorize` — this mounts an unauthenticated, unbounded-write endpoint. Pass an RLS `authorize` gate, or set `public: true` (or `silent: true`) to confirm this bucket is intentionally open.",
        );
    }

    const fetch = async (request: Request): Promise<Response> => {
        if (protocol !== "tus" && request.method === "DELETE") {
            return methodNotAllowedResponse(protocol);
        }

        const declaredSize = declaredUploadSize(request, protocol);

        if (declaredSize !== undefined && declaredSize > maxFileSize) {
            return tooLargeResponse(protocol);
        }

        const context: UploadAuthzContext = { method: request.method, protocol, request, url: new URL(request.url) };

        if (authorize !== undefined) {
            try {
                // Read back as `unknown` and compared to `true`, never tested for
                // truthiness. The gate is DECLARED to answer a boolean, but it is
                // app code and untyped JavaScript reaches it: an
                // `async ({ request }) => verifySignedUrl(new URL(request.url), secret)`
                // that forgot its `.valid` hands back `{ valid: false }`, which is
                // TRUTHY. This is the WRITE path, so passing that through is an
                // attacker putting bytes in the bucket. Mirrors
                // `@lunora/server`'s `isServeAuthorized` on the read path.
                const allowed: unknown = await authorize(context);

                if (allowed !== true) {
                    return denyResponse(protocol);
                }
            } catch {
                // A throwing RLS callback is a denial, never a 500 — fail closed.
                return denyResponse(protocol);
            }
        }

        if (maxFileSizeFor !== undefined && isCreateRequest(request, protocol)) {
            const refused = await checkSizeFor(maxFileSizeFor, context, maxFileSize);

            if (refused !== undefined) {
                return refused;
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

export type { CreateUploadHandlerOptions, R2UploadStorageOptions, UploadAuthzContext, UploadHandler, UploadProtocol, UploadSizeContext, UploadStorage };
export { createR2UploadStorage, createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES };
