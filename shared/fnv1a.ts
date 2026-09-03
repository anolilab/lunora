/**
 * Canonical FNV-1a digests — 32-bit ({@link fnv1aHex}) and 64-bit
 * ({@link fnv1a64Hex}) — shared by the server's mask middleware
 * (`@lunora/server`'s `"hash"` strategy), the studio's data-browser mask
 * preview (`@lunora/studio`), and the three 64-bit callers
 * (`@lunora/replica`'s deterministic insert ids, `@lunora/notify`'s persisted
 * subscription primary keys, `@lunora/agent`'s workflow dedup instance ids).
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
 * deterministic and non-cryptographic: same input → same token. `Math.imul`
 * keeps the multiply in 32-bit space.
 *
 * Iterates UTF-16 code UNITS (`charCodeAt`), which is what
 * `@lunora/client`'s `hashToken` and the Dart SDK's `_hashToken` do — the three
 * are the same digest and must stay byte-for-byte identical. The earlier
 * `codePointAt`-per-index walk folded an astral character TWICE (its full code
 * point at the first index, then its trailing low surrogate at the second), so
 * `fnv1aHex("😀")` produced `0faeabcd` where every other implementation of the
 * algorithm produces `cb31c4b8`.
 *
 * `offset` exists only so `shared/content-digest.ts` can run the same hash under
 * a second basis and concatenate the two. It is not a salt — FNV-1a is unkeyed,
 * and a caller choosing a different basis gets a different-but-equally-guessable
 * token, not a secret one.
 */
const fnv1aHex = (input: string, offset: number = FNV1A_OFFSET_BASIS): string => {
    let hash = offset;

    for (let index = 0; index < input.length; index += 1) {
        // eslint-disable-next-line unicorn/prefer-code-point -- code UNITS: matches @lunora/client's hashToken and the Dart SDK, and keeps an astral char from being folded twice
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, FNV1A_PRIME);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
};

/** One 16-bit limb of the 64-bit state, as 4 lowercase hex digits. */
const hex4 = (limb: number): string => limb.toString(16).padStart(4, "0");

/**
 * FNV-1a (64-bit) digest of `input`, as 16 lowercase hex digits.
 *
 * The hash state is held as four 16-bit limbs in plain `number`s rather than a
 * `BigInt`. BigInt allocates a heap object per operation, and this runs once per
 * character of the hash input — the limb form measures ~5x faster in isolation
 * (`packages/replica/__bench__/apply-diff-hotpath.bench.ts` benches THIS
 * function, imported, against the BigInt form over a fixed string) and produces
 * bit-identical digests (`packages/replica/__tests__/apply-diff.test.ts` pins the
 * two together over random and boundary inputs, including astral code points and
 * lone surrogates).
 *
 * The FNV-1a prime `0x0000_0100_0000_01b3` has only two non-zero 16-bit limbs
 * (`0x01b3` at limb 0 and `0x0100` at limb 2), so the full 4x4 limb product
 * collapses to the two multiplications per limb below. Every intermediate stays
 * well under 2^32, so `>>> 16` is a valid carry extraction.
 *
 * The three consumers MUST agree byte-for-byte, which is why this lives here and
 * is not copy-pasted per package: `@lunora/notify` derives a *persisted*
 * subscription primary key from it, so a digest that drifts in one copy silently
 * re-keys every existing subscription (the old row goes dark, the new row is a
 * duplicate).
 *
 * A checksum, NOT a cryptographic hash — unkeyed, unsalted, and trivially
 * invertible for a low-entropy input. Never use it to hide a value.
 */
const fnv1a64Hex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    // Offset basis 0xcbf29ce484222325, low limb first.
    let h0 = 0x23_25;
    let h1 = 0x84_22;
    let h2 = 0x9c_e4;
    let h3 = 0xcb_f2;

    for (let index = 0; index < input.length; index += 1) {
        const point = input.codePointAt(index) ?? 0;

        // A code point above the BMP occupies limbs 0 and 1.
        h0 ^= point & 0xff_ff;
        h1 ^= (point >>> 16) & 0xff_ff;

        const p0 = h0 * 0x01_b3;
        const p1 = h1 * 0x01_b3;
        const p2 = h2 * 0x01_b3 + h0 * 0x01_00;
        const p3 = h3 * 0x01_b3 + h1 * 0x01_00;

        const c1 = p1 + (p0 >>> 16);
        const c2 = p2 + (c1 >>> 16);
        const c3 = p3 + (c2 >>> 16);

        h0 = p0 & 0xff_ff;
        h1 = c1 & 0xff_ff;
        h2 = c2 & 0xff_ff;
        h3 = c3 & 0xff_ff;
    }

    return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
    /* eslint-enable no-bitwise */
};

export { FNV1A_OFFSET_BASIS, FNV1A_PRIME, fnv1a64Hex, fnv1aHex };
