import { LunoraError } from "lunorash/errors";

/** Cap on one file, matching what an editor can hold and a model can reasonably read. */
const MAX_FILE_BYTES = 256_000;

/** Shared encoder — instantiating one per write would allocate on every agent turn. */
const UTF8 = new TextEncoder();

/**
 * The size of `content` as it is actually stored.
 *
 * `String.length` counts UTF-16 code units, which is neither bytes nor
 * characters: an emoji is 2 units, `"ä"` is 1 unit but encodes to 2 bytes, and a
 * file of CJK text is roughly a third of its real byte size. Measuring the
 * encoded length is the only way {@link MAX_FILE_BYTES} means what its name says.
 */
const utf8ByteLength = (content: string): number => UTF8.encode(content).byteLength;

/**
 * Reject content that would exceed the per-file cap, naming the real byte size.
 *
 * Applied to the RESULT of every write path, not to the payload: an anchored
 * `edit` that swaps one character for a megabyte is a tiny patch producing an
 * oversized file, so checking the incoming argument alone would leave the cap
 * enforced on `write` and unenforced on `edit`.
 */
const assertWithinLimit = (path: string, content: string): void => {
    const bytes = utf8ByteLength(content);

    if (bytes > MAX_FILE_BYTES) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", `write: ${path} is ${String(bytes)} bytes, over the ${String(MAX_FILE_BYTES)} limit`);
    }
};

/**
 * Compare-and-swap guard for a file write.
 *
 * `expected` is the `revision` the writer read the file at. `undefined` means the
 * writer is not claiming one — the agent's own tools read and write inside a
 * single durable step, so they have nothing to race — and the write proceeds
 * unconditionally. `0` means "I expected this file not to exist yet", which is
 * what the editor sends for a file it just created.
 */
const assertRevision = (path: string, current: number, expected: number | undefined): void => {
    if (expected === undefined || expected === current) {
        return;
    }

    throw new LunoraError(
        "CONFLICT",
        `write: ${path} has changed since you read it (revision ${String(current)}, you expected ${String(expected)}). ` +
            `Reload the file and re-apply your edit.`,
    );
};

export { assertRevision, assertWithinLimit, MAX_FILE_BYTES, utf8ByteLength };
