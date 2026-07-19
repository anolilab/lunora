/**
 * Built-in fixed-window chunker: split into `size`-char windows overlapping by
 * `overlap` chars. Deliberately simple and deterministic — the zero-config
 * default. Token-aware / sentence / semantic strategies plug in via
 * `RagConfig.chunk`.
 * @experimental
 */
const fixedWindowChunks = (text: string, size: number, overlap: number): ReadonlyArray<string> => {
    if (!Number.isInteger(size) || size < 1) {
        throw new RangeError("fixedWindowChunks: `size` must be a positive integer");
    }

    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
        throw new RangeError("fixedWindowChunks: `overlap` must be a non-negative integer smaller than `size`");
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
        return [];
    }

    if (trimmed.length <= size) {
        return [trimmed];
    }

    const step = Math.max(1, size - overlap);
    const chunks: string[] = [];

    for (let start = 0; start < trimmed.length; start += step) {
        chunks.push(trimmed.slice(start, start + size));

        if (start + size >= trimmed.length) {
            break;
        }
    }

    return chunks;
};

export default fixedWindowChunks;
