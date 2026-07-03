/**
 * Built-in fixed-window chunker: split into `size`-char windows overlapping by
 * `overlap` chars. Deliberately simple and deterministic — the zero-config
 * default. Token-aware / sentence / semantic strategies plug in via
 * `RagConfig.chunk`.
 */
const fixedWindowChunks = (text: string, size: number, overlap: number): ReadonlyArray<string> => {
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
