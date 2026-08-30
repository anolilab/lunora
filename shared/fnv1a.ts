/**
 * Canonical FNV-1a (32-bit) digest shared by the server's mask middleware
 * (`@lunora/server`'s `"hash"` strategy) and the studio's data-browser mask
 * preview (`@lunora/studio`).
 *
 * It is deliberately **not** a package. The studio must not depend on the server
 * runtime, and the server's digest is an implementation detail of one middleware
 * — there is no shared package the two could import without coupling the admin
 * UI bundle to the worker runtime. Instead each consumer imports this file by
 * relative path and the bundler inlines it: no runtime dependency edge, one
 * source of truth, zero deps.
 *
 * The two sides MUST agree byte-for-byte: the studio's toggle renders a
 * *preview* of what a `.use(mask(...))` caller receives, so any drift makes the
 * preview lie about the data. Sharing the implementation is what enforces that;
 * `packages/studio/__tests__/features/data/data-browser-mask.test.tsx` pins a
 * handful of digests against this function to catch an accidental change to the
 * algorithm itself.
 *
 * SECURITY: this is NOT a confidentiality control. It is unsalted, deterministic
 * and narrow (~2^32 outputs), so a low-entropy input (email / phone / SSN) is
 * brute-force-recoverable by the same caller the mask is meant to blind, and
 * equal values always yield equal tokens (cross-row/tenant correlation). The
 * `"hash"` mask strategy exists for stable pseudonymous grouping/joining ONLY;
 * PII that must stay hidden must use `"redact"`.
 */

/** The standard FNV-1a 32-bit offset basis. The default; `contentDigest` passes the prime as a second basis to widen its digest. */
const FNV1A_OFFSET_BASIS = 0x81_1c_9d_c5;

/** The FNV-1a 32-bit prime. */
const FNV1A_PRIME = 0x01_00_01_93;

/**
 * FNV-1a (32-bit) digest of `input`, as zero-padded 8-char lowercase hex. Fast,
 * deterministic and non-cryptographic: same input → same token. Iterates by
 * `codePointAt` per UTF-16 index (so a non-BMP character contributes its astral
 * code point at the first index and a lone low surrogate at the second);
 * `Math.imul` keeps the multiply in 32-bit space.
 *
 * `offset` exists only so `shared/content-digest.ts` can run the same hash under
 * a second basis and concatenate the two. It is not a salt — FNV-1a is unkeyed,
 * and a caller choosing a different basis gets a different-but-equally-guessable
 * token, not a secret one.
 */
const fnv1aHex = (input: string, offset: number = FNV1A_OFFSET_BASIS): string => {
    let hash = offset;

    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.codePointAt(index) ?? 0;
        hash = Math.imul(hash, FNV1A_PRIME);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
};

export { FNV1A_OFFSET_BASIS, FNV1A_PRIME, fnv1aHex };
