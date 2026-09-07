/**
 * Byte-budgeted request-body readers shared across the worker's handlers and the
 * extracted admin-route modules. Extracted from `create-worker.ts` so the
 * orchestration / admin route modules can drain bodies under the same
 * authoritative cap without importing runtime values from `create-worker`
 * (keeping the module edge one-directional).
 *
 * `Content-Length` is forgeable — a chunked request omits it and a non-numeric
 * value makes the header guard `NaN` — so the cap is re-checked while the bytes
 * arrive, not only from the header. Each reader aborts with a 413 the moment
 * cumulative bytes exceed the budget, before the oversized payload is buffered.
 */
import { LunoraError } from "./errors";

/**
 * The maximum request-body size (1 MiB) the planes the framework dispatches
 * accept — the reserved `/_lunora/*` surface and the `/api/auth/*` plane. An
 * app's own `httpRouter` routes read their own bodies and so choose their own
 * budget; the entry-point fast-path deliberately does not pre-reject them.
 * Enforced in two layers: a cheap (forgeable) `Content-Length` fast-path at the
 * entry point, and an authoritative byte budget applied while reading the body —
 * `parseEnvelope`, `parseMigrateRequest`, `parseExportBody`, and `streamingImport`
 * all abort with a 413 once cumulative bytes exceed this cap, so a chunked or
 * length-stripped payload can't slip past.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * `true` iff `x` is a plain, non-null, non-array object — the one definition
 * of "plain JSON object" shared by every guard that rejects a caller-supplied
 * `args`/body value before it reaches `JSON.stringify`, the shard RPC body, or
 * a property lookup. `assertArgsObject` (`./assert-args-object`) imports this
 * rather than re-deriving the same check.
 */
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Read a request body fully into text while enforcing a hard byte budget as the
 * bytes arrive. `Content-Length` is forgeable — a chunked request omits it
 * (so the header guard sees `0`) and a non-numeric value makes the header guard
 * `NaN` (so the guard is skipped) — therefore the cap MUST be re-checked while
 * reading, not only from the header. Aborts with a 413 the moment cumulative
 * bytes exceed {@link MAX_BODY_BYTES}, before the oversized payload is buffered.
 *
 * A `null` body (GET-style request with no body) decodes to `""`.
 */
const readBodyTextWithLimit = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<string> => {
    if (!request.body) {
        return "";
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            total += value.byteLength;

            if (total > limit) {
                // Stop pulling more bytes; release the underlying stream.
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before throwing
                await reader.cancel().catch(() => {});

                throw new LunoraError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }

            text += decoder.decode(value, { stream: true });
        }
    }

    text += decoder.decode();

    return text;
};

/**
 * Read a request body fully into an `ArrayBuffer` while enforcing the same hard
 * byte budget {@link readBodyTextWithLimit} applies — used by the admin storage
 * upload path, which carries arbitrary binary bytes rather than text. Aborts
 * with a 413 the moment cumulative bytes exceed {@link MAX_BODY_BYTES}. A `null`
 * body (no payload) decodes to an empty buffer.
 */
const readBodyBytesWithLimit = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<ArrayBuffer> => {
    if (!request.body) {
        return new ArrayBuffer(0);
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            total += value.byteLength;

            if (total > limit) {
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before throwing
                await reader.cancel().catch(() => {});

                throw new LunoraError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }

            chunks.push(value);
        }
    }

    const out = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return out.buffer;
};

/**
 * Drain + parse a JSON body under the byte cap (defaults to the authoritative
 * {@link MAX_BODY_BYTES}; pass a larger `limit` for endpoints whose payloads
 * legitimately exceed 1 MiB), tolerating an empty body (`{}`) and a non-object
 * root (callers that accept one default it themselves). `label` names the
 * endpoint in the 400 (`"<label> body must be valid JSON"`); a 413 from the
 * reader passes through unchanged. {@link readJsonBodyWithLimit} is this plus
 * the plain-object guard.
 */
const readLooseJsonBody = async (request: Request, label: string, limit: number = MAX_BODY_BYTES): Promise<unknown> => {
    try {
        const text = await readBodyTextWithLimit(request, limit);

        return text === "" ? {} : JSON.parse(text);
    } catch (error) {
        if (error instanceof LunoraError) {
            throw error;
        }

        throw new LunoraError(`${label} body must be valid JSON`, { code: "BAD_REQUEST", status: 400 });
    }
};

/**
 * Read a JSON request body under a byte cap — {@link readLooseJsonBody} plus the
 * plain-object guard. `null`, `[1, 2]`, and a bare scalar all parse cleanly, and
 * a caller dereferencing a property on one would 500 where the malformed request
 * deserves a 400 — so anything that isn't a plain, non-null, non-array object is
 * rejected here, once, and every caller inherits the guard instead of
 * re-deriving it.
 */
const readJsonBodyWithLimit = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> => {
    const body = await readLooseJsonBody(request, "Request", limit);

    if (!isPlainObject(body)) {
        throw new LunoraError("Request body must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    return body;
};

export { isPlainObject, MAX_BODY_BYTES, readBodyBytesWithLimit, readBodyTextWithLimit, readJsonBodyWithLimit, readLooseJsonBody };
