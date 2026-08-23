/**
 * A short, synchronous, non-cryptographic digest of a string — the shared
 * change-detection primitive for "is this the same content I saw last time?".
 *
 * FNV-1a over the text, run twice with different offsets and concatenated to
 * widen the result to ~64 bits. Deliberately NOT `node:crypto` or
 * `crypto.subtle`: every caller runs synchronously inside a Durable Object —
 * `runShardMigrations` on a cold start, the reactor comparison inside a write
 * flush — where `subtle.digest` is async and `node:crypto` is absent.
 *
 * Content addressing here is for identity and dedup, never for security. A
 * collision means two different contents compare equal, so a caller must be able
 * to state what that costs it: the schema ledger keeps the older snapshot, and a
 * reactor skips one run it should have made. Both are acceptable at ~64 bits;
 * neither is a merged row or a silent corruption. Anything that needs an
 * adversary-resistant digest wants `@lunora/fingerprint`'s SHA-256 path instead.
 */

/** One FNV-1a pass over `text` from `offset`, as 8 lowercase hex chars. */
const fnv1a = (text: string, offset: number): string => {
    let hash = offset;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.codePointAt(index) ?? 0;
        // FNV prime 16777619, applied with `Math.imul` to stay inside 32-bit int math.
        hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
};

/**
 * Digest `text` to a 16-character hex string.
 * @returns the digest — stable for identical input, across runs and hosts.
 */
const contentDigest = (text: string): string => `${fnv1a(text, 0x81_1c_9d_c5)}${fnv1a(text, 0x01_00_01_93)}`;

export { contentDigest };
