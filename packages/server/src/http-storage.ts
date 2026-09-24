/**
 * Serving a stored R2 object over HTTP: `Range`/206, `ETag`, digest headers, and
 * the response hardening that keeps an uploaded byte stream from executing on
 * the serving origin.
 *
 * Split out of `http.ts`, which owns the typed route builder and the SSE
 * handler — this half shares nothing with those beyond
 * {@link isSafeHeaderValue}. `serveStorageObject` and its public types are
 * re-exported from the package barrel, so the public surface is unchanged.
 */
import { isSafeHeaderValue } from "./http";

/**
 * Structural view of an R2 object body, as returned by `@lunora/storage`'s
 * `download()`. Re-declared here (not imported) so `@lunora/server` takes no
 * runtime dependency on `@lunora/storage`; the real binding satisfies the shape.
 */
interface StorageObjectBody {
    /** The object body stream (`null` for a zero-byte object). */
    body: ReadableStream | null;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    /** Hex SHA-256, when R2 carries a checksum (surfaced by `@lunora/storage`). */
    sha256?: string;
    /** Base64 SHA-256 (RFC 9530 digest encoding), when R2 carries a checksum. */
    sha256Base64?: string;
    size: number;
}

/** Byte window forwarded to `download()` so R2 streams just the requested slice. */
interface StorageRange {
    length: number;
    offset: number;
}

/**
 * The minimal storage surface {@link serveStorageObject} needs: a metadata-rich
 * `download`, plus the body-free `head` a range request resolves against.
 *
 * `head` is required rather than optional-with-a-fallback because the fallback
 * is the bug: without it a ranged request has to start a full-object `download`
 * just to learn the size, then throw that body away. `@lunora/storage`'s `head`
 * already degrades internally to a 0-length ranged `get()` on a binding with no
 * HEAD, so there is nothing a caller here could usefully do that it does not.
 */
interface StorageHead {
    /** Object metadata with no body. `size` is the FULL object size (mirrors R2). */
    head: (key: string) => Promise<Omit<StorageObjectBody, "body"> | null>;
}

/** The storage surface {@link serveStorageObject} reads through. */
interface StorageDownloader extends StorageHead {
    download: (key: string, options?: { range?: StorageRange }) => Promise<StorageObjectBody | null>;
}

/** Any ctx that carries a {@link StorageDownloader} on `.storage` (Query/Mutation/Action ctx all do). */
interface ContextWithStorage {
    storage: StorageDownloader;
}

/** Hoisted so the single-range matcher isn't recompiled on every request. */
const SINGLE_BYTE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * RFC 7232 requires an `ETag` field-value to be a quoted-string (or `W/`-prefixed
 * weak validator). R2's `object.etag` is the *unquoted* MD5 hex, so emitting it
 * verbatim produces a malformed header that conditional-request clients and CDNs
 * will never match against `If-None-Match: "…"`. Wrap it in quotes unless the
 * source already carries them (or a weak prefix).
 */
const toHttpEtag = (etag: string): string => {
    if (etag.startsWith('"') || etag.startsWith('W/"')) {
        return etag;
    }

    return `"${etag}"`;
};

/**
 * Outcome of parsing a `Range` header. `kind: "full"` → no/ignorable range
 * (serve the whole object as 200); `kind: "partial"` → a resolved inclusive
 * `[start, end]` (serve 206); `kind: "unsatisfiable"` → syntactically valid but
 * out of bounds (serve 416).
 */
type RangeResult = { end: number; kind: "partial"; start: number } | { kind: "full" } | { kind: "unsatisfiable" };

/**
 * Parse a single-range `Range: bytes=start-end` header against a known object
 * `size`. Only a single byte range is supported; a multi-range request
 * (`bytes=0-1,3-4`) is ignored and the full object is served — the common
 * media-streaming case is a single range, and multipart/byteranges responses
 * add disproportionate complexity.
 */
const parseRange = (header: null | string, size: number): RangeResult => {
    if (header === null) {
        return { kind: "full" };
    }

    const match = SINGLE_BYTE_RANGE_RE.exec(header.trim());

    if (!match) {
        // Multi-range or malformed — ignore and serve the whole object.
        return { kind: "full" };
    }

    const startRaw = match[1] ?? "";
    const endRaw = match[2] ?? "";

    if (startRaw === "" && endRaw === "") {
        return { kind: "full" };
    }

    let start: number;
    let end: number;

    if (startRaw === "") {
        // Suffix range `bytes=-N`: the final N bytes.
        const suffix = Number(endRaw);

        if (suffix === 0) {
            return { kind: "unsatisfiable" };
        }

        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(startRaw);
        end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
    }

    if (start > end || start >= size) {
        return { kind: "unsatisfiable" };
    }

    return { end, kind: "partial", start };
};

/**
 * Content types safe to render inline on the serving origin. Raster images and
 * media only: they carry no script and no same-origin DOM.
 *
 * `image/svg+xml` is deliberately ABSENT even though it is an image — an SVG is
 * a scriptable document, so rendering an uploaded one inline is stored XSS.
 * Everything else (documents, text, `text/html`, unknown types) gets
 * `content-disposition: attachment`, which is what `examples/team-chat`'s
 * hand-wired route does for every object.
 */
const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "image/apng",
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/webm",
]);

/**
 * The headers every representation of an object carries — its content-type, its
 * validator, the RFC 9530 digest when R2 recorded a checksum, and the two
 * headers that keep an uploaded byte stream from executing on this origin.
 *
 * `contentType` originates from object metadata set at upload time, so it is
 * attacker-influenced. A value carrying CR/LF (or other control chars) would
 * either throw inside `Response`/`Headers` construction (→ unhandled 500) or,
 * on a permissive runtime, smuggle an injected response header. Reject any
 * unsafe value and fall back to the safe default rather than reflecting it.
 *
 * `x-content-type-options: nosniff` always rides along, and anything outside
 * {@link INLINE_SAFE_CONTENT_TYPES} is forced to `content-disposition:
 * attachment` — an uploader who pinned `text/html` or `image/svg+xml` into the
 * signed PUT gets a download, not a same-origin script.
 */
const storageObjectHeaders = (object: Omit<StorageObjectBody, "body">, cacheControl: string): Record<string, string> => {
    const rawContentType = object.httpMetadata?.contentType;
    const contentType = rawContentType !== undefined && isSafeHeaderValue(rawContentType) ? rawContentType : "application/octet-stream";
    const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        // Defaults to `no-store` because every response this helper produces
        // passed a MANDATORY per-request `authorize` gate keyed on the caller's
        // session or signature, so the bytes are private to that identity.
        // Without it the browser (and any shared proxy) may keep them and replay
        // the cached copy after a logout or an account switch — a second
        // identity reading the first one's object with `authorize` never called
        // again. An app fronting a genuinely public bucket overrides it; see
        // `serveStorageObject`'s `cacheControl`.
        "cache-control": cacheControl,
        "content-type": contentType,
        etag: toHttpEtag(object.etag),
        "x-content-type-options": "nosniff",
    };

    // Match on the bare type: a parameterised `text/html; charset=utf-8` must
    // not slip past the allowlist on its parameters.
    if (!INLINE_SAFE_CONTENT_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "")) {
        headers["content-disposition"] = "attachment";
    }

    if (object.sha256Base64 !== undefined) {
        // RFC 9530 representation digest so clients can verify integrity. The
        // value is a structured-field byte-sequence (base64 wrapped in colons),
        // and it covers the full representation, so it's correct on a 206 too.
        headers["repr-digest"] = `sha-256=:${object.sha256Base64}:`;
    }

    return headers;
};

/**
 * Whether `header` degrades to the whole object no matter how big the object is:
 * absent, multi-range, malformed, or a bare `bytes=-`.
 *
 * Every branch of {@link parseRange} that answers `"full"` returns before `size`
 * is read, so probing with `0` is a header-only question — which lets a request
 * that can never be a 206 skip the metadata read instead of paying for one and
 * throwing it away.
 */
const rangeDegradesToWholeObject = (header: null | string): boolean => parseRange(header, 0).kind === "full";

/** The whole object as a `200`, streamed from a single `download()`. */
const serveWholeStorageObject = async (context: ContextWithStorage, key: string, cacheControl: string): Promise<Response> => {
    const object = await context.storage.download(key);

    if (!object) {
        return new Response("Not Found", { status: 404 });
    }

    return new Response(object.body, {
        headers: { ...storageObjectHeaders(object, cacheControl), "content-length": String(object.size) },
        status: 200,
    });
};

/** The decision a {@link StorageServeAuthorizer} is asked to make. */
interface StorageServeAuthzContext {
    /** The object key the caller asked for — already resolved by the route. */
    key: string;
    /** The inbound request, so the gate can read the signed-URL query, a cookie, or a bearer. */
    request: Request;
}

/**
 * The authorization decision for THIS object — {@link serveStorageObject}'s
 * required fourth argument, because the helper has no other way to know whether
 * the caller may read `key`. Return `true` to stream, anything else for a
 * **403**; a throwing gate is a denial too, never a 500 (fail closed, mirroring
 * `@lunora/storage`'s `createUploadHandler`).
 *
 * For a signed-URL topology this is where `verifySignedUrl` goes:
 * `async ({ request }) => (await verifySignedUrl(new URL(request.url), secret)).valid`.
 */
type StorageServeAuthorizer = (context: StorageServeAuthzContext) => boolean | Promise<boolean>;

/**
 * Run the mandatory gate, fail-closed. Only an exact `true` allows: a gate that
 * throws (a verifier blowing up on a malformed signature) or returns anything
 * else denies, so a broken check can never become an open bucket.
 */
const isServeAuthorized = async (authorize: StorageServeAuthorizer, key: string, request: Request): Promise<boolean> => {
    try {
        // Read back as `unknown` and compared to `true`, not returned as-is. The
        // gate is DECLARED to answer a boolean, but it is app code and untyped
        // JavaScript reaches it: an `async ({ request }) => verifySignedUrl(…)`
        // that forgot its `.valid` hands back `{ valid: false }`, which is
        // TRUTHY. Passing that through turned a denial into an open bucket at the
        // one check that decides whether the bytes are streamed.
        const verdict: unknown = await authorize({ key, request });

        return verdict === true;
    } catch {
        return false;
    }
};

/**
 * Stream a stored object as an HTTP {@link Response} from an `httpAction`
 * handler, with correct `Content-Type`, `ETag`, and `Accept-Ranges: bytes`.
 * Honors a single-range `Range` request → **206 Partial Content** with
 * `Content-Range` + `Content-Length`; otherwise **200**. A missing object is a
 * **404**; an out-of-bounds range is a **416** with a `Content-Range` of
 * `bytes` star-slash-size.
 *
 * `authorize` runs FIRST and is mandatory: this helper reads bytes out of a
 * bucket and hands them to whoever asked, so without a gate every mounted route
 * is an open object store. It does not verify signed URLs by itself — pass
 * `verifySignedUrl` (or a session check) as the gate.
 *
 * Every response carries `x-content-type-options: nosniff`, and any object whose
 * content type is not a raster image or media file also carries
 * `content-disposition: attachment` — an uploader-pinned `text/html` or
 * `image/svg+xml` must never render on the serving origin.
 *
 * A range request resolves its window against a body-free `head()`, then issues
 * ONE `download()` with the resolved `{ offset, length }` so R2 streams just
 * those bytes — the slice is never buffered in the isolate, and no full-object
 * body transfer is started only to be cancelled. A request that cannot produce a
 * 206 at all (no `Range`, multi-range, malformed) skips the `head()` entirely and
 * streams straight from a single `download()`. For very
 * large objects a signed URL (`ctx.storage.getSignedUrl`) is still cheaper since
 * the client then ranges against R2/CDN directly with no Worker hop.
 *
 * `cacheControl` defaults to `no-store`, which is right whenever `authorize`
 * scopes the bytes to an identity. It is a parameter rather than something
 * derived from `authorize` because a stub returning `true` during development
 * would then silently publish a cache. An app fronting a genuinely public
 * bucket passes its own value; `content-disposition` and `nosniff` stay
 * unconditional either way. Note the default also defeats conditional
 * revalidation, so the `etag` computed here can never answer a 304.
 */
const serveStorageObject = async (
    context: ContextWithStorage,
    key: string,
    request: Request,
    authorize: StorageServeAuthorizer,
    cacheControl = "no-store",
): Promise<Response> => {
    if (!(await isServeAuthorized(authorize, key, request))) {
        // No reason, no distinction from a missing object's 404 shape beyond the
        // status: a precise answer here is a signing / existence oracle.
        return new Response("Forbidden", { status: 403 });
    }

    const rangeHeader = request.headers.get("range");

    // No `Range`, or one that cannot produce a 206 anyway (multi-range, malformed):
    // the object's own metadata rides along with its body, so there is nothing to
    // look up first — and paying for a `head()` here would only add a round trip
    // and a window for the object to vanish between the two reads.
    if (rangeDegradesToWholeObject(rangeHeader)) {
        return serveWholeStorageObject(context, key, cacheControl);
    }

    // A range has to be resolved against the object's size before it can be
    // requested, so this read exists only for the metadata — which is exactly why
    // it is a `head()` and not a `download()`.
    const metadata = await context.storage.head(key);

    if (!metadata) {
        return new Response("Not Found", { status: 404 });
    }

    const range = parseRange(rangeHeader, metadata.size);

    if (range.kind === "unsatisfiable") {
        // The body here is a plain-text error, not the object — so it carries
        // neither the object's `Content-Type` nor its digest. Only the
        // range-relevant headers (and the resource ETag) ride along.
        return new Response("Range Not Satisfiable", {
            headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${String(metadata.size)}`,
                "content-type": "text/plain; charset=utf-8",
                etag: toHttpEtag(metadata.etag),
            },
            status: 416,
        });
    }

    // Unreachable: the whole-object check at the top already answered this, and
    // its answer does not depend on `size`. Kept so the union stays exhaustive.
    if (range.kind === "full") {
        return serveWholeStorageObject(context, key, cacheControl);
    }

    const length = range.end - range.start + 1;
    const slice = await context.storage.download(key, { range: { length, offset: range.start } });

    if (!slice) {
        // Raced with a delete between the metadata read and the ranged read.
        return new Response("Not Found", { status: 404 });
    }

    // Headers come from `metadata`, not `slice`: the validator, the digest and the
    // `Content-Range` total must all describe the ONE representation the window
    // was resolved against. (An object replaced between the two reads is a
    // pre-existing race either way — this at least keeps the header set coherent.)
    return new Response(slice.body, {
        headers: {
            ...storageObjectHeaders(metadata, cacheControl),
            "content-length": String(length),
            "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(metadata.size)}`,
        },
        status: 206,
    });
};

export { serveStorageObject };

export type { StorageServeAuthorizer, StorageServeAuthzContext };
