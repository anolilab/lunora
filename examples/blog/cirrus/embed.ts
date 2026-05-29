/**
 * Demonstration embedder — a deterministic, dependency-free hashing bag-of-tokens
 * projection into a fixed-dimension unit vector. It lets this example build and
 * run end-to-end without an external model. Cirrus is bring-your-own-embedder:
 * in a real app swap this for a managed model (Workers AI
 * `@cf/baai/bge-base-en-v1.5`, OpenAI, etc.) and set EMBED_DIMENSIONS to that
 * model's output size.
 */
export const EMBED_DIMENSIONS = 256;

export const embedText = (input: string): number[] => {
    const vector = Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0);
    const tokens = input.toLowerCase().match(/[a-z0-9]+/gu) ?? [];

    for (const token of tokens) {
        // FNV-1a over the token → a stable bucket in [0, EMBED_DIMENSIONS).
        let hash = 0x81_1c_9d_c5;

        for (const character of token) {
            hash ^= character.codePointAt(0) ?? 0;
            hash = Math.imul(hash, 0x01_00_01_93);
        }

        vector[(hash >>> 0) % EMBED_DIMENSIONS] += 1;
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

    return vector.map((value) => value / magnitude);
};
