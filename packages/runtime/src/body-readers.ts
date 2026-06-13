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
import { CirrusError } from "./errors";

/**
 * The maximum request-body size (1 MiB) the worker's `/_cirrus/*` plane accepts.
 * Enforced in two layers: a cheap (forgeable) `Content-Length` fast-path at the
 * entry point, and an authoritative byte budget applied while reading the body —
 * `parseEnvelope`, `parseMigrateRequest`, `parseExportBody`, and `streamingImport`
 * all abort with a 413 once cumulative bytes exceed this cap, so a chunked or
 * length-stripped payload can't slip past.
 */
const MAX_BODY_BYTES = 1_048_576;

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

                throw new CirrusError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
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

                throw new CirrusError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
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
 * Read a JSON request body under the authoritative {@link MAX_BODY_BYTES} cap.
 *
 * Mirrors `parseExportBody`/`parseMigrateRequest`: drains the body through the
 * byte-budgeted reader (so a chunked / Content-Length-stripped payload can't
 * slip past the cap) and maps a 413 through unchanged while turning any other
 * parse failure into a 400. Returns `{}` for an empty body.
 */
const readJsonBodyWithLimit = async (request: Request): Promise<Record<string, unknown>> => {
    try {
        const text = await readBodyTextWithLimit(request);

        return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch (error) {
        if (error instanceof CirrusError) {
            throw error;
        }

        throw new CirrusError("Request body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }
};

export { MAX_BODY_BYTES, readBodyBytesWithLimit, readBodyTextWithLimit, readJsonBodyWithLimit };
