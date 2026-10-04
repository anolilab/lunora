/**
 * R2's multipart rules, shared by the in-memory R2 binding and the R2 S3 API
 * fakes: every part but the last is at least 5 MiB, and all of those are the
 * same size.
 */

const MIN_PART_SIZE = 5 * 1024 * 1024;

/** Whether R2 would complete a multipart upload of these parts, in order. */
const validParts = (parts: ReadonlyArray<Uint8Array>): boolean => {
    const leading = parts.slice(0, -1);

    return leading.every((part) => part.byteLength >= MIN_PART_SIZE && part.byteLength === leading[0]?.byteLength);
};

/** The parts joined into the object's bytes. */
const concatParts = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;

    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }

    return bytes;
};

export { concatParts, validParts };
