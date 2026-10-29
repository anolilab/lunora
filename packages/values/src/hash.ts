/* eslint-disable no-bitwise, import/prefer-default-export -- cyrb53 is bit arithmetic; the one export is re-exported from the package index */

/**
 * A cyrb53 string hash — fast, well-distributed, 53-bit, with good avalanche
 * behaviour. Public-domain (bryc). Two independent accumulators seeded from
 * `seed` are mixed and combined; we down-fold the 53-bit result to an unsigned
 * 32-bit integer for faker's seed.
 */
export const cyrb53 = (text: string, seed = 0): number => {
    let h1 = 0xde_ad_be_ef ^ seed;
    let h2 = 0x41_c6_ce_57 ^ seed;

    for (let index = 0; index < text.length; index += 1) {
        const ch = text.codePointAt(index) ?? 0;

        h1 = Math.imul(h1 ^ ch, 2_654_435_761);
        h2 = Math.imul(h2 ^ ch, 1_597_334_677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

    return 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
};
