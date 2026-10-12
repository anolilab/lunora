/**
 * Read a request body as UTF-8 text under a hard byte budget, streaming so an
 * oversized body is never buffered in full.
 *
 * Shared by `@lunora/runtime`'s `readBodyTextWithLimit` (which throws a 413) and
 * `@lunora/platform-node`'s dispatch route. The caller picks the error; this file
 * stays free of `@lunora/errors`, so it is safe to inline into any host.
 *
 * Like `shared/constant-time-equal.ts`, it is not a package: keep it
 * zero-dependency (relative imports only) or bundler inlining breaks.
 */

/**
 * Returns the body as text, or `null` when it exceeds `limit` bytes. Over budget,
 * the stream is cancelled before more bytes are pulled. A missing body decodes to
 * `""`.
 */
const readBodyTextCapped = async (request: Request, limit: number): Promise<string | null> => {
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
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before returning
                await reader.cancel().catch(() => {});

                return null;
            }

            text += decoder.decode(value, { stream: true });
        }
    }

    text += decoder.decode();

    return text;
};

export { readBodyTextCapped };
