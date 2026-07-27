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
// JS is single-threaded, so there is no reentrancy: the encoder is stateless
// for `encode`, and the message schedule `w` is fully overwritten (indices
// 0-15 from the block, 16-63 derived) before any entry is read each block.
// This keeps every fingerprint from allocating a fresh encoder + 256-byte
// scratch array — the hash is the floor of the whole package and runs once per
// grouped row. (`K` above is already a module-level singleton for the same
// reason.)
const textEncoder = new TextEncoder();
const w = new Uint32Array(64);

const toHex = (value: number): string => (value >>> 0).toString(16).padStart(8, "0");

export const sha256Hex = (message: string): string => {
    const bytes = textEncoder.encode(message);

    // Padded length: message + 0x80 marker + zero fill + 8-byte length, rounded
    // up to a whole number of 64-byte blocks.
    const bitLength = bytes.length * 8;
    const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;

    const view = new DataView(buffer.buffer);
    // 64-bit big-endian bit length in the final 8 bytes. Lengths well below 2^32
    // bits keep the high word zero (fingerprint inputs are short strings).
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);

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
            w[index] = view.getUint32(offset + index * 4, false);
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
