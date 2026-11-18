/**
 * A request body's bytes, or `undefined` once the running total passes
 * `maxBytes` — a chunked body has no declared length, so the cap is held while
 * it streams in and nothing past it is ever buffered.
 */
export const readCappedBytes = async (stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> => {
    if (stream === null) {
        return new Uint8Array(0);
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a body is read in order; each chunk depends on the last
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
            reader.cancel().catch(() => undefined);

            return undefined;
        }

        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
};

/** Whether the request's `content-length` already declares more than `maxBytes`, so it can be refused unread. */
export const declaresOver = (request: Request, maxBytes: number): boolean => {
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);

    return Number.isFinite(declared) && declared > maxBytes;
};
