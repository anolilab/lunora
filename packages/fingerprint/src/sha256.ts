/**
 * Portable, synchronous SHA-256 (FIPS 180-4) returning a lowercase hex digest.
 *
 * Vendored so `@lunora/fingerprint` stays genuinely zero-dependency and runs
 * unchanged on every Lunora runtime: the browser (Studio), the Cloudflare
 * Workers (workerd) runtime (`@lunora/do`, `apps/cloud`), and Node. The two
 * built-in alternatives both fall short here:
 *   - `crypto.subtle.digest("SHA-256", …)` is async, which is awkward for the
 *     row-by-row grouping the fingerprinter drives (a synchronous key is far
 *     nicer to fold rows with).
 *   - `node:crypto`'s `createHash` — what upstream superlog uses — is not
 *     available in the browser and needs `nodejs_compat` in workerd.
 *
 * This is a straightforward, self-contained implementation. It is **not**
 * constant-time and is intended for content-addressing / grouping keys only —
 * never for secrets or message authentication.
 */

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
    0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
    0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift));

// Module-level singletons, reused across calls. `sha256Hex` is synchronous and
// JS is single-threaded, so there is no reentrancy: the message schedule `w` is
// fully overwritten (indices 0-15 from the block, 16-63 derived) before any
// entry is read each block, and the scratch buffer's padding region is zeroed
// before every use. The hash runs once per grouped row, and for the short
// canonical strings fingerprinting feeds it, allocating an encoded copy, a
// padded buffer and a DataView per call cost more than the compression itself.
const textEncoder = new TextEncoder();
const w = new Uint32Array(64);

// Inputs above this get a one-off buffer, so a single huge message cannot pin
// a multi-megabyte scratch for the life of the isolate.
const SCRATCH_MAX = 64 * 1024;

let scratch = new Uint8Array(1024);

// Two hex digits per byte value: eight table reads beat eight
// `toString(16).padStart(8, "0")` calls on the digest.
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

const toHex = (value: number): string =>
    (HEX[value >>> 24] as string) + (HEX[(value >>> 16) & 0xff] as string) + (HEX[(value >>> 8) & 0xff] as string) + (HEX[value & 0xff] as string);

export const sha256Hex = (message: string): string => {
    // UTF-8 never needs more than three bytes per UTF-16 code unit (a lone
    // surrogate encodes as U+FFFD), plus room for the 0x80 marker, zero fill,
    // and the 8-byte length.
    const capacity = message.length * 3 + 72;
    let buffer = scratch;

    if (capacity > buffer.length) {
        if (capacity <= SCRATCH_MAX) {
            buffer = new Uint8Array(capacity);
            scratch = buffer;
        } else {
            // Size a huge buffer for ASCII (one byte per unit) rather than the
            // worst case, so an unbounded message does not triple its footprint.
            buffer = new Uint8Array(message.length + 72);
        }
    }

    const first = textEncoder.encodeInto(message, buffer);
    let length = first.written;

    // Multi-byte input outgrew the optimistic buffer (or left no room for the
    // padding): redo it at worst-case size.
    if (first.read < message.length || length + 72 > buffer.length) {
        buffer = new Uint8Array(capacity);
        length = textEncoder.encodeInto(message, buffer).written;
    }

    // Padded length: message + 0x80 marker + zero fill + 8-byte length, rounded
    // up to a whole number of 64-byte blocks.
    const paddedLength = (((length + 8) >> 6) + 1) << 6;

    // The scratch still holds the previous message's bytes past `length`.
    buffer.fill(0, length, paddedLength);
    buffer[length] = 0x80;

    // 64-bit big-endian bit length in the final 8 bytes.
    const bitLength = length * 8;
    const high = Math.floor(bitLength / 0x1_0000_0000);

    buffer[paddedLength - 8] = high >>> 24;
    buffer[paddedLength - 7] = high >>> 16;
    buffer[paddedLength - 6] = high >>> 8;
    buffer[paddedLength - 5] = high;
    buffer[paddedLength - 4] = bitLength >>> 24;
    buffer[paddedLength - 3] = bitLength >>> 16;
    buffer[paddedLength - 2] = bitLength >>> 8;
    buffer[paddedLength - 1] = bitLength;

    // First 32 bits of the fractional parts of the square roots of the first 8 primes.
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            const at = offset + index * 4;

            w[index] =
                (((buffer[at] as number) << 24) | ((buffer[at + 1] as number) << 16) | ((buffer[at + 2] as number) << 8) | (buffer[at + 3] as number)) >>> 0;
        }

        for (let index = 16; index < 64; index += 1) {
            const w15 = w[index - 15] as number;
            const w2 = w[index - 2] as number;
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            w[index] = (((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) | 0) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let index = 0; index < 64; index += 1) {
            const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + bigS1 + ch + (K[index] as number) + (w[index] as number)) >>> 0;
            const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (bigS0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
};
