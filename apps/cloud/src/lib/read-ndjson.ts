/**
 * Read a streaming NDJSON body line by line, shared by the build box and the
 * provision box readers.
 *
 * A JSON object split across two reads is the normal case for a streaming body,
 * not an edge one, so lines are buffered until their newline arrives. A final
 * line without a trailing newline is still delivered.
 *
 * `TextDecoder` with `{ stream: true }` rather than `TextDecoderStream`: the
 * latter is not in the Node floor this package declares, and a multi-byte
 * character split across two chunks has to survive either way.
 *
 * Reads to the end: abandoning the stream cancels the container's response, and
 * the last lines — the ones explaining a failure — are exactly the ones that
 * would be lost.
 */
const readNdjson = async (body: ReadableStream<Uint8Array>, onLine: (line: string) => Promise<void>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- reading a stream is inherently sequential
        const { done, value } = await reader.read();

        buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });

        const lines = buffered.split("\n");

        buffered = done ? "" : (lines.pop() ?? "");

        for (const line of lines.filter((candidate) => candidate.trim() !== "")) {
            // eslint-disable-next-line no-await-in-loop -- lines must land in order
            await onLine(line);
        }

        if (done) {
            return;
        }
    }
};

export default readNdjson;
