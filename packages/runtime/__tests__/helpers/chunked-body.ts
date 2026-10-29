/**
 * A chunked request body for the body-budget tests: bytes arrive in pieces with
 * NO `Content-Length`, so the entry-point header fast path cannot see the size
 * and only the byte-budgeted reader can reject it. `Request` does not synthesize
 * the header either, which is exactly the shape a chunked upload has on the wire.
 */

/**
 * Streams `prefix`, then padding that strictly exceeds `exceedBytes`, then
 * `suffix` — so a caller passes the cap it wants the body to be over and gets a
 * body over it, with no rounding to reason about at the call site.
 *
 * `prefix`/`suffix` wrap the padding in JSON when the route must parse the body
 * to reach the assertion; omit both when the reader rejects it unparsed.
 */
const chunkedBody = ({ exceedBytes, prefix = "", suffix = "" }: { exceedBytes: number; prefix?: string; suffix?: string }): ReadableStream<Uint8Array> => {
    const chunk = new Uint8Array(256 * 1024).fill(120); // 'x'
    const encoder = new TextEncoder();
    const padChunks = Math.floor(exceedBytes / chunk.byteLength) + 1;
    // Index-driven: chunk 0 is the prefix, the next `padChunks` are padding, and
    // the one after that is the suffix and closes the stream — so what a reader
    // has to follow is the enqueue order, not a counter shared between two roles.
    let index = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const current = index;

            index += 1;

            if (current === 0) {
                controller.enqueue(encoder.encode(prefix));
            } else if (current <= padChunks) {
                controller.enqueue(chunk);
            } else {
                controller.enqueue(encoder.encode(suffix));
                controller.close();
            }
        },
    });
};

// Sole export, so `default` is the form the repo's lint rule requires here.
export default chunkedBody;
