/** The fields a waitlist sign-up may carry; each is checked where it is read. */
interface WaitlistBody {
    email?: unknown;
    honeyField?: unknown;
    privacy?: unknown;
    source?: unknown;
}

/** An address and three short fields fit many times over; anything larger is not the form. */
const MAX_WAITLIST_BODY_BYTES = 4096;

/**
 * The parsed sign-up, `"too_large"` for a body over {@link MAX_WAITLIST_BODY_BYTES}, or `undefined` when it is not
 * a JSON object. The endpoint is public, so the size is checked before the body is buffered and parsed.
 */
const readWaitlistBody = async (request: Request): Promise<WaitlistBody | "too_large" | undefined> => {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_WAITLIST_BODY_BYTES) {
        return "too_large";
    }

    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";

    // The header can be absent or wrong, so the limit also holds while the stream is read.
    while (reader !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > MAX_WAITLIST_BODY_BYTES) {
            // eslint-disable-next-line no-await-in-loop -- the loop ends here
            await reader.cancel();

            return "too_large";
        }

        text += decoder.decode(value, { stream: true });
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text + decoder.decode());
    } catch {
        return undefined;
    }

    // `null`, an array or a scalar parses, but carries none of the fields.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
};

export type { WaitlistBody };
export { MAX_WAITLIST_BODY_BYTES, readWaitlistBody };
