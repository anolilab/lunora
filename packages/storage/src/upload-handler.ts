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
 * `createR2UploadStorage`, an in-memory provider in tests).
 *
 * The `authorize` callback is the RLS decision: it runs before every request
 * (create, chunk PATCH, resume HEAD, delete) and denies fail-closed — a thrown
 * callback is a deny, never a 500. For TUS and chunked REST, a request declaring
 * a size over `maxFileSize` is refused (413) before it reaches the gate. A
 * finished upload cannot be deleted through the handler: TUS refuses to
 * terminate one, and the other protocols refuse `DELETE` outright (405).
 *
 * The route is write-only. `GET`, and any method the protocol does not need to
 * upload, is refused (405) before the gate runs, so the route never serves a
 * stored file. So is any request carrying a method-override header, which
 * would change the method after that check. Downloads go through
 * `ctx.storage.download()` or a signed URL.
 *
 * ## Workers compatibility
 *
 * The `node:async_hooks` import below is static, so it is this whole module —
 * not just the `AsyncLocalStorage` construction — that fails on a Worker which
 * cannot resolve it: the graph never loads, before any export is reached. On
 * Workers, a `compatibility_date` of `2026-08-04` or later enables
 * `nodejs_compat` (and `nodejs_compat_v2`) by default; earlier dates need
 * `nodejs_compat`, or `nodejs_als` alone — the narrower flag that turns on
 * `AsyncLocalStorage` only — in `compatibility_flags`. Deferring the
 * construction below to first use would not lift the requirement while the
 * import stays static. Node.js provides the module natively, so no flag
 * applies there.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { LunoraError } from "@lunora/errors";
import { ERRORS, File } from "@visulima/storage";
import { Multipart, Rest, Tus } from "@visulima/storage/handler/http/fetch";

import type { DeclaredFile, RouteCheck, RoutePolicy } from "./tus-route-policy";
import { TUS_RESUMABLE, tusRoutePolicy } from "./tus-route-policy";

/** Resumable upload wire protocols the handler can speak. */
type UploadProtocol = "chunked-rest" | "multipart" | "tus";

/**
 * Default ceiling applied to `maxFileSize` when the caller doesn't supply one
 * (100 MiB). Without SOME cap, an unauthenticated or loosely-authorized
 * handler accepts an unbounded request body — pass an explicit `maxFileSize`
 * to raise or lower this for your app.
 */
const DEFAULT_MAX_UPLOAD_BYTES: number = 100 * 1024 * 1024;

/**
 * The largest TUS chunk `@visulima/storage` buffers in memory to verify an
 * `Upload-Checksum` the provider cannot verify itself; larger ones are refused
 * (`413`) unread. Peak memory is about twice this, so upstream's 64 MiB default
 * would let one request take most of a Worker isolate's 128 MB.
 */
const MAX_CHECKSUM_BUFFER_BYTES: number = 16 * 1024 * 1024;

// Derive the visulima handler option/storage types from the class constructors
// so we never import `@visulima/storage`'s internal `BaseStorage` / `UploadFile`
// symbols (they are not part of the fetch-handler entry's public surface).
type UploadHandlerOptions = ConstructorParameters<typeof Tus>[0];

/** A `@visulima/storage` storage provider (e.g. `createR2UploadStorage` or a memory provider in tests). */
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

declare const GRANTED: unique symbol;

/**
 * A grant `authorize` answers to admit a request and hand the rest of it a
 * `Context`. Opaque: only {@link UploadContext.grant} issues one, so a value
 * the gate builds by hand, or picks up by mistake (`{ valid: false, context }`),
 * is not a grant and is denied.
 */
interface UploadGrant<Context = unknown> {
    readonly [GRANTED]: Context;
}

/** What {@link CreateUploadHandlerOptions.authorize} answers: allow, deny, a grant, or the response to refuse with. */
type UploadAuthorizeResult<Context = unknown> = boolean | Response | UploadGrant<Context>;

/** A grant as the handler holds it: what it carries, and the {@link UploadContext} that issued it. */
interface IssuedGrant {
    readonly context: unknown;
    readonly issuer: object;
}

/** Every grant issued, by its token. Membership is the brand: a hand-built object is never in it. */
const issuedGrants = new WeakMap<object, IssuedGrant>();

/** The grant the current upload request was admitted with, for as long as it runs. */
const activeGrant = new AsyncLocalStorage<IssuedGrant | undefined>();

/**
 * A typed channel from `authorize` to the storage provider's callbacks
 * (`filename`, `onCreate`, `onComplete`, …), which get only the file.
 * `authorize` answers `grant(context)`, and the callbacks read the context back
 * with `get()`, so one handler and one provider serve every caller.
 */
interface UploadContext<Context> {
    /**
     * The context the current request was granted. Throws when there is none:
     * outside an upload request, or when `authorize` answered `true` or a grant
     * from another `UploadContext`.
     */
    get: () => Context;
    /** A grant that admits the request and carries `context` to {@link UploadContext.get}. */
    grant: (context: Context) => UploadGrant<Context>;
}

/**
 * Create an {@link UploadContext}, typed by what `authorize` grants:
 *
 * ```ts
 * const caller = createUploadContext<{ userId: string }>();
 *
 * filename: (file) => `uploads/${caller.get().userId}/${file.id}`,
 * authorize: async ({ request }) => caller.grant({ userId: await userIdFrom(request) }),
 * ```
 */
const createUploadContext = <Context>(): UploadContext<Context> => {
    const channel: UploadContext<Context> = {
        get: () => {
            const active = activeGrant.getStore();

            if (active?.issuer !== channel) {
                throw new LunoraError(
                    "INTERNAL",
                    "@lunora/storage: no upload grant from this UploadContext is active. Read it from a storage callback of a request `authorize` admitted with its grant()",
                );
            }

            // Only `grant` below stores a context under this issuer, and it takes a `Context`.
            return active.context as Context;
        },
        grant: (context) => {
            const token = Object.freeze({}) as UploadGrant<Context>;

            issuedGrants.set(token, { context, issuer: channel });

            return token;
        },
    };

    return channel;
};

/**
 * The context handed to {@link CreateUploadHandlerOptions.maxFileSizeFor}: the
 * authorization context plus what the create request declares about the file.
 * Everything here comes from the client, so it caps an upload by what the
 * client SAYS it is; `allowMIME` on the provider is what checks the type.
 */
interface UploadSizeContext<Context = unknown> extends UploadAuthzContext {
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

    /** The context `authorize` granted this request, or `undefined` when it answered `true` or there is no `authorize`. */
    granted: Context | undefined;
    /** The decoded TUS `Upload-Metadata`, or the chunked-REST `X-File-Metadata` JSON, as strings. */
    metadata: Record<string, string>;
}

/** Options for {@link createUploadHandler}. */
interface CreateUploadHandlerOptions<Context = unknown> {
    /**
     * The RLS gate. Runs before every upload request and denies fail-closed:
     * only `true` or an {@link UploadGrant} (from {@link UploadContext.grant})
     * lets the request through; `false`, anything else, **or throwing** yields
     * a `403`. A `Response` is answered instead of the `403`, for a refusal of
     * your own (say a `429` with `Retry-After`): it is passed through as it
     * is, except that a TUS route adds `Tus-Resumable` when it has none. It is
     * meant for 4xx/5xx; a 2xx would tell the client an upload happened. Omit
     * only for a fully public bucket — the whole point of this handler over
     * the admin path is that uploads are gated by *your* per-user policy, not
     * an admin token.
     *
     * Omitting it mounts an unauthenticated, unbounded-write endpoint, so
     * doing so logs a one-time warning (per handler) unless `silent`/`public`
     * says the omission is intentional.
     */
    authorize?: (context: UploadAuthzContext) => UploadAuthorizeResult<Context> | Promise<UploadAuthorizeResult<Context>>;

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
    maxFileSizeFor?: (context: UploadSizeContext<Context>) => number | undefined | Promise<number | undefined>;
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

/** An error in visulima's `ApiError` shape, so `@visulima/storage-client` surfaces `status` and `code`. */
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
 * The methods an upload route answers, per protocol: the ones that create an
 * upload, send its bytes, read its offset back to resume (`HEAD`), and CORS
 * preflight (`OPTIONS`). Everything else is refused (405) before `authorize`
 * runs, so the route stays write-only.
 *
 * `GET` serves stored files on every protocol as of `@visulima/storage` 2.0.24
 * (streamed downloads, `Range`, `/:id/metadata`, and the file list when
 * `allowList` is on), and TUS served them before that. Behind the WRITE gate
 * that would let anyone allowed to upload, or anyone at all on a `public`
 * route, read any file by id. Reads go through `ctx.storage.download()` and
 * signed URLs, which have their own read-side gate.
 *
 * `DELETE` on the chunked-REST and multipart handlers removes any stored file
 * by id (chunked REST also in batches, via `?ids=`), and neither honors
 * `disableTerminationForFinishedUploads`. TUS keeps it to abort an upload in
 * progress, and refuses to terminate a finished one.
 */
const ALLOWED_METHODS: Readonly<Record<UploadProtocol, ReadonlySet<string>>> = {
    "chunked-rest": new Set(["HEAD", "OPTIONS", "PATCH", "POST", "PUT"]),
    multipart: new Set(["OPTIONS", "POST"]),
    tus: new Set(["DELETE", "HEAD", "OPTIONS", "PATCH", "POST"]),
};

const methodNotAllowedResponse = (protocol: UploadProtocol, message: string): Response => {
    const response = errorResponse(protocol, 405, { code: "METHOD_NOT_ALLOWED", message, name: "MethodNotAllowedError" });

    response.headers.set("Allow", [...ALLOWED_METHODS[protocol]].join(", "));

    return response;
};

/**
 * Headers that ask a server to treat the request as another method, after
 * {@link ALLOWED_METHODS} and `authorize` ran on `request.method`: a `POST`
 * overridden to `GET` would pass the write gate and be served as a read.
 */
const METHOD_OVERRIDE_HEADERS = ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"] as const;

/** A declared size: decimal digits only, as TUS and HTTP define it. */
const DIGITS = /^\d+$/u;

/** One extension, as upstream strips it from a chunked-REST id. */
const EXTENSION = /\.[^.]+$/u;

/** A name upstream's `PUT` accepts for a new file. */
const CLIENT_FILE_ID = /^[\w-]{1,255}$/u;

/**
 * The id a chunked-REST `PUT` would create, or `undefined` when upstream
 * refuses the request anyway (an id it does not accept, no `Content-Length`,
 * a size over the provider's `maxUploadSize`). Those keep upstream's own
 * `400`/`413`, so a refused request learns nothing about the name from a
 * `409`. An empty body (`Content-Length: 0`) is checked like any other: since
 * storage 2.0.33 upstream takes it, and its `PUT` replaces an existing upload.
 */
const putCreateId = (request: Request, storage: UploadStorage): string | undefined => {
    const id = (new URL(request.url).pathname.split("/").findLast(Boolean) ?? "").replace(EXTENSION, "");
    const header = request.headers.get("Content-Length")?.trim() ?? "";
    const length = DIGITS.test(header) ? Number(header) : Number.NaN;

    return CLIENT_FILE_ID.test(id) && Number.isSafeInteger(length) && length <= storage.maxUploadSize ? id : undefined;
};

const isFileNotFound = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { UploadErrorCode?: unknown }).UploadErrorCode === ERRORS.FILE_NOT_FOUND;

/**
 * Whether a chunked-REST `PUT` names an upload that exists, which upstream's
 * `PUT` would replace. Only a confirmed "not found" counts as free. A stored
 * object without upload state upstream refuses itself (visulima/visulima#919),
 * and the R2 binding provider again, atomically, when it writes.
 */
const putTargetExists = async (id: string, storage: UploadStorage): Promise<boolean> => {
    try {
        await storage.getMeta(id);

        return true;
    } catch (error) {
        return !isFileNotFound(error);
    }
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
 * Everything the route refuses before `authorize` runs: a method the protocol
 * does not need to upload, a method-override header, a declared size over
 * `maxFileSize`, and the protocol policy's own checks. Answers the refusal, or
 * what the request declares about its file.
 */
const checkBeforeGate = (request: Request, protocol: UploadProtocol, maxFileSize: number, policy: RoutePolicy): RouteCheck => {
    // HTTP methods are case-sensitive, and the protocol handlers dispatch on
    // the exact string. `Request` upper-cases the standard ones (`get`,
    // `post`, …) but keeps `patch` as sent, so a lowercase `patch` is not
    // `PATCH`: refused here, before the gate, like any other method.
    const { method } = request;

    if (!ALLOWED_METHODS[protocol].has(method)) {
        return {
            refusal: methodNotAllowedResponse(
                protocol,
                `${method} is not allowed on this upload route: it is write-only. Serve stored files with ctx.storage.download() or a signed URL`,
            ),
        };
    }

    const override = METHOD_OVERRIDE_HEADERS.find((header) => request.headers.has(header));

    if (override !== undefined) {
        return { refusal: methodNotAllowedResponse(protocol, `${override} is not allowed on this upload route: send the request with the method itself`) };
    }

    const declaredSize = declaredUploadSize(request, protocol);

    if (declaredSize !== undefined && declaredSize > maxFileSize) {
        return { refusal: tooLargeResponse(protocol) };
    }

    return policy.check(request);
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

/** Chunked REST stores the request's `Content-Type` (an empty one falls back, as in the REST handler) and its `X-File-Metadata`. */
const restRoutePolicy: RoutePolicy = {
    check: (request) => {
        const header = request.headers.get("Content-Type");

        return {
            declared: {
                contentType: header === null || header === "" ? "application/octet-stream" : header,
                metadata: restMetadata(request.headers.get("X-File-Metadata")),
            },
        };
    },
    finish: (_request, response) => response,
};

/** Multipart declares nothing a per-upload cap reads: its size is only known once the form is parsed. */
const multipartRoutePolicy: RoutePolicy = {
    check: () => {
        return { declared: { contentType: undefined, metadata: {} } };
    },
    finish: (_request, response) => response,
};

/**
 * What a create request declares about its file. The MIME type is resolved by
 * building the same `File` the protocol handler builds, so the cap is decided
 * on the type that is then stored: on chunked REST the request's
 * `Content-Type`, on TUS the metadata's `mimeType`, then `type`, then
 * `filetype`.
 */
const describeFile = (declared: DeclaredFile): { contentType: string; metadata: Record<string, string> } => {
    const file = new File({ contentType: declared.contentType, metadata: declared.metadata });
    const strings: Record<string, string> = {};

    for (const [key, value] of Object.entries(declared.metadata)) {
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
const checkSizeFor = async <Context>(
    maxFileSizeFor: NonNullable<CreateUploadHandlerOptions<Context>["maxFileSizeFor"]>,
    context: UploadAuthzContext,
    granted: Context | undefined,
    declared: DeclaredFile,
    maxFileSize: number,
): Promise<Response | undefined> => {
    const declaredSize = declaredUploadSize(context.request, context.protocol);
    let cap: unknown;

    try {
        cap = await maxFileSizeFor({ ...context, ...describeFile(declared), declaredSize, granted });
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

/**
 * A `Response` the gate answered, passed through as it is. A TUS client reads
 * `Tus-Resumable` on every response, so a TUS route adds it when it is missing.
 */
const gateResponse = (protocol: UploadProtocol, response: Response): Response => {
    if (protocol !== "tus" || response.headers.has("Tus-Resumable")) {
        return response;
    }

    // A copy: the gate's own response may have immutable headers (a `fetch` result, `Response.redirect`).
    const copy = new Response(response.body, response);

    copy.headers.set("Tus-Resumable", TUS_RESUMABLE);

    return copy;
};

/**
 * Run `authorize` and decide: the response that refuses the request, or the
 * grant it was admitted with (`undefined` for a plain `true`).
 *
 * The verdict is read back as `unknown`, and only an exact `true` or a grant
 * {@link createUploadContext} issued allows, never a truthy value or an object
 * that merely looks like a grant. The gate is app code and untyped JavaScript
 * reaches it: an `async ({ request }) => verifySignedUrl(new URL(request.url), secret)`
 * that forgot its `.valid` hands back `{ valid: false }`, which is TRUTHY. This
 * is the WRITE path, so passing that through is an attacker putting bytes in
 * the bucket. Mirrors `@lunora/server`'s `isServeAuthorized` on the read path.
 */
const runGate = async <Context>(
    authorize: NonNullable<CreateUploadHandlerOptions<Context>["authorize"]>,
    context: UploadAuthzContext,
): Promise<Response | { granted: IssuedGrant | undefined }> => {
    let verdict: unknown;

    try {
        verdict = await authorize(context);
    } catch {
        // A throwing RLS callback is a denial, never a 500 — fail closed.
        return denyResponse(context.protocol);
    }

    if (verdict instanceof Response) {
        return gateResponse(context.protocol, verdict);
    }

    if (verdict === true) {
        return { granted: undefined };
    }

    const granted = typeof verdict === "object" && verdict !== null ? issuedGrants.get(verdict) : undefined;

    return granted === undefined ? denyResponse(context.protocol) : { granted };
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

/** The protocol's route policy. A provider declares the checksums it verifies as a class field, so it is read once. */
const routePolicy = (protocol: UploadProtocol, storage: UploadStorage): RoutePolicy => {
    if (protocol === "tus") {
        return tusRoutePolicy(storage.checksumTypes.length > 0);
    }

    return protocol === "chunked-rest" ? restRoutePolicy : multipartRoutePolicy;
};

/**
 * Build an RLS-gated resumable upload handler over a `@visulima/storage`
 * provider. Mount its {@link UploadHandler.fetch} on the route your client
 * uploads to and drive it with `@visulima/storage-client`.
 */
const createUploadHandler = <Context = unknown>(options: CreateUploadHandlerOptions<Context>): UploadHandler => {
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
        // Read only by the TUS handler. Defence in depth beside
        // METHOD_OVERRIDE_HEADERS, which lists only the names known today.
        allowMethodOverride: false,
        // A finished upload is a stored file; removing it is the app's call
        // (`ctx.storage.delete`), not a `DELETE` any caller the upload gate
        // admits can send to the upload route.
        disableTerminationForFinishedUploads: true,
        // Read only by the TUS handler; see MAX_CHECKSUM_BUFFER_BYTES.
        maxChecksumBufferSize: MAX_CHECKSUM_BUFFER_BYTES,
        maxFileSize,
        storage: options.storage,
    };

    const handler = instantiateHandler(protocol, handlerOptions);
    const policy = routePolicy(protocol, options.storage);

    const { authorize, maxFileSizeFor } = options;

    if (authorize === undefined && !options.silent && !options.public) {
        // One-time warning per handler instance — mirrors `@lunora/notify`'s
        // one-time unsafe-default warn (`packages/notify/src/notify.ts`).
        // eslint-disable-next-line no-console -- one-time misconfiguration warning, mirrors other unsafe-default fallbacks
        console.warn(
            "@lunora/storage: createUploadHandler() has no `authorize` — this mounts an unauthenticated, unbounded-write endpoint. Pass an RLS `authorize` gate, or set `public: true` (or `silent: true`) to confirm this bucket is intentionally open.",
        );
    }

    /** The rest of a request `authorize` let through, run with its grant in {@link activeGrant}. */
    const admitted = async (request: Request, context: UploadAuthzContext, granted: IssuedGrant | undefined, declared: DeclaredFile): Promise<Response> => {
        if (maxFileSizeFor !== undefined && isCreateRequest(request, protocol)) {
            // Only a grant from an `UploadContext<Context>` reaches here (see `runGate`).
            const refused = await checkSizeFor(maxFileSizeFor, context, granted?.context as Context | undefined, declared, maxFileSize);

            if (refused !== undefined) {
                return refused;
            }
        }

        // Last, after `authorize` and every size check, and only for a request
        // upstream would carry out: so a caller learns whether a name is taken
        // only when it may store a file under that name.
        const putId = protocol === "chunked-rest" && request.method === "PUT" ? putCreateId(request, options.storage) : undefined;

        if (putId !== undefined && (await putTargetExists(putId, options.storage))) {
            return errorResponse(protocol, 409, { code: "FileConflict", message: "A file already exists under this name", name: "ConflictError" });
        }

        return policy.finish(request, await handler.fetch(request));
    };

    const fetch = async (request: Request): Promise<Response> => {
        const checked = checkBeforeGate(request, protocol, maxFileSize, policy);

        if ("refusal" in checked) {
            return checked.refusal;
        }

        const context: UploadAuthzContext = { method: request.method, protocol, request, url: new URL(request.url) };
        const gate = authorize === undefined ? { granted: undefined } : await runGate(authorize, context);

        if (gate instanceof Response) {
            return gate;
        }

        return activeGrant.run(gate.granted, async () => admitted(request, context, gate.granted, checked.declared));
    };

    return { fetch, protocol };
};

export type {
    CreateUploadHandlerOptions,
    UploadAuthorizeResult,
    UploadAuthzContext,
    UploadContext,
    UploadGrant,
    UploadHandler,
    UploadProtocol,
    UploadSizeContext,
    UploadStorage,
};
export { createUploadContext, createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES };
