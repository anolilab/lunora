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
     * this handler itself against the request's declared size (`Upload-Length`
     * / `Content-Length`) — see {@link declaredUploadSize}. Defaults to
     * {@link DEFAULT_MAX_UPLOAD_BYTES} (100 MiB) — pass this to raise or lower
     * the ceiling; there is no unbounded option.
     */
    maxFileSize?: number;
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
 * protocols. TUS's create (`POST`) declares the total size via
 * `Upload-Length`; REST/other single-shot requests carry it in
 * `Content-Length`.
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
const declaredUploadSize = (request: Request, protocol: UploadProtocol): number | undefined => {
    if (protocol === "multipart") {
        return undefined;
    }

    const raw = request.headers.get("Upload-Length") ?? request.headers.get("Content-Length");

    if (raw === null) {
        return undefined;
    }

    const parsed = Number(raw);

    return Number.isFinite(parsed) ? parsed : undefined;
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

    const handlerOptions: UploadHandlerOptions = {
        maxFileSize,
        storage: options.storage,
    };

    const handler = instantiateHandler(protocol, handlerOptions);

    const { authorize } = options;

    if (authorize === undefined && !options.silent && !options.public) {
        // One-time warning per handler instance — mirrors `@lunora/notify`'s
        // one-time unsafe-default warn (`packages/notify/src/notify.ts`).
        // eslint-disable-next-line no-console -- one-time misconfiguration warning, mirrors other unsafe-default fallbacks
        console.warn(
            "@lunora/storage: createUploadHandler() has no `authorize` — this mounts an unauthenticated, unbounded-write endpoint. Pass an RLS `authorize` gate, or set `public: true` (or `silent: true`) to confirm this bucket is intentionally open.",
        );
    }

    const fetch = async (request: Request): Promise<Response> => {
        const declaredSize = declaredUploadSize(request, protocol);

        if (declaredSize !== undefined && declaredSize > maxFileSize) {
            return tooLargeResponse(protocol);
        }

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
                const allowed: unknown = await authorize({ method: request.method, protocol, request, url: new URL(request.url) });

                if (allowed !== true) {
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
export { createR2UploadStorage, createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES };
