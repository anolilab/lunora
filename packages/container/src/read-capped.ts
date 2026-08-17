/**
 * A bounded, cancellable body reader.
 *
 * Its own module because both consumers need it and neither owns it: the
 * cold-start retry scans a response prefix for a provisioning sentinel, and the
 * exec contract reads a whole (capped) result document.
 */

/** The outcome of a bounded body read: the decoded text, and whether the cap cut it short. */
interface CappedBody {
    /** `true` when the body still had bytes left when the limit was reached. */
    overflowed: boolean;
    /** The decoded prefix, at most `limit` bytes' worth. */
    text: string;
}

/**
 * Read at most `limit` bytes off `stream`, then cancel the reader so the rest is
 * never pulled. `text()`-then-slice cannot substitute: it buffers the WHOLE body
 * first, so the cap protects the string's length and nothing about the memory
 * that produced it. Inside a 128MB isolate that distinction is the difference
 * between a failed call and a terminated isolate.
 *
 * `signal` is what keeps a bounded read from becoming an unbounded *wait*. An
 * abort does not interrupt a pending `read()` on its own once `fetch` has handed
 * the body over, so the listener cancels the reader — that is what unblocks it —
 * and the signal's reason is re-thrown afterwards, so a caller sees the deadline
 * that fired rather than a silently short body.
 */
const readCapped = async (stream: Response["body"], limit: number, signal?: AbortSignal): Promise<CappedBody> => {
    if (stream === null) {
        return { overflowed: false, text: "" };
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const onAbort = (): void => {
        reader.cancel().catch(() => undefined);
    };

    signal?.addEventListener("abort", onAbort);

    let text = "";
    let bytes = 0;
    let overflowed = false;

    try {
        while (signal?.aborted !== true) {
            // eslint-disable-next-line no-await-in-loop -- sequentially accumulate a bounded prefix, then stop.
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            bytes += value.byteLength;

            if (bytes > limit) {
                overflowed = true;

                break;
            }

            text += decoder.decode(value, { stream: true });
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        await reader.cancel();
    }

    if (signal?.aborted === true) {
        throw signal.reason as Error;
    }

    return { overflowed, text };
};

export type { CappedBody };
export { readCapped };
