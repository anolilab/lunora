/**
 * Byte plumbing for the binding-backed upload provider: reading a request body
 * chunk by chunk, and a queue whose front is copied out before it is consumed.
 */

/** One body chunk as bytes. */
const toBytes = (chunk: unknown): Uint8Array => {
    if (chunk instanceof Uint8Array) {
        return chunk;
    }

    if (typeof chunk === "string") {
        return new TextEncoder().encode(chunk);
    }

    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }

    throw new TypeError("Unsupported upload body chunk");
};

const isWebStream = (body: object): body is ReadableStream<unknown> => typeof (body as Partial<ReadableStream>).getReader === "function";

/**
 * Iterate a request body chunk by chunk. The fetch handlers hand over the
 * request's web `ReadableStream` (or `null` for an empty body); the
 * multipart-form handler a Node `Readable`. Anything else is a `TypeError`.
 */
const readBody = async function* readBody(body: unknown): AsyncGenerator<Uint8Array> {
    if (body === null || body === undefined) {
        return;
    }

    if (body instanceof Uint8Array) {
        yield body;

        return;
    }

    if (typeof body === "object" && isWebStream(body)) {
        const reader = body.getReader();

        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
                const { done, value } = await reader.read();

                if (done) {
                    return;
                }

                yield toBytes(value);
            }
        } finally {
            reader.releaseLock();
        }
    }

    if (typeof body === "object" && Symbol.asyncIterator in body) {
        for await (const chunk of body as AsyncIterable<unknown>) {
            yield toBytes(chunk);
        }

        return;
    }

    throw new TypeError("Unsupported upload body");
};

/** A FIFO of byte chunks. The front is read with {@link ByteQueue.copyFront} and dropped only once it has been stored. */
class ByteQueue {
    public size = 0;

    private readonly chunks: Uint8Array[] = [];

    public push(chunk: Uint8Array): void {
        if (chunk.byteLength > 0) {
            this.chunks.push(chunk);
            this.size += chunk.byteLength;
        }
    }

    /** Copy the first `length` bytes into `target` at `offset`, leaving the queue as it is. */
    public copyFront(target: Uint8Array, offset: number, length: number): void {
        let written = 0;

        for (const chunk of this.chunks) {
            if (written >= length) {
                break;
            }

            const take = Math.min(chunk.byteLength, length - written);

            target.set(chunk.subarray(0, take), offset + written);
            written += take;
        }
    }

    /** Drop the first `length` bytes. */
    public drop(length: number): void {
        let remaining = length;

        while (remaining > 0) {
            const head = this.chunks[0];

            if (head === undefined) {
                break;
            }

            if (head.byteLength <= remaining) {
                this.chunks.shift();
                remaining -= head.byteLength;
            } else {
                this.chunks[0] = head.subarray(remaining);
                remaining = 0;
            }
        }

        this.size -= length - remaining;
    }
}

export { ByteQueue, readBody, toBytes };
