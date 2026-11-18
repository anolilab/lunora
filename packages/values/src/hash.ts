/**
 * A cyrb53 string hash — fast, well-distributed, 53-bit, with good avalanche
 * behaviour. Public-domain (bryc). Two independent accumulators seeded from
 * `seed` are mixed and combined; we down-fold the 53-bit result to an unsigned
 * 32-bit integer for faker's seed.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the package index re-exports it by name, per the repo's no-default-mixing convention
export const cyrb53 = (text: string, seed = 0): number => {
    // eslint-disable-next-line no-bitwise -- cyrb53 is defined over XOR, AND and unsigned shifts: the bit ops are the algorithm
    let h1 = 0xde_ad_be_ef ^ seed;
    // eslint-disable-next-line no-bitwise -- as above
    let h2 = 0x41_c6_ce_57 ^ seed;

    for (let index = 0; index < text.length; index += 1) {
        const ch = text.codePointAt(index) ?? 0;

        // eslint-disable-next-line no-bitwise -- as above
        h1 = Math.imul(h1 ^ ch, 2_654_435_761);
        // eslint-disable-next-line no-bitwise -- as above
        h2 = Math.imul(h2 ^ ch, 1_597_334_677);
    }

    // eslint-disable-next-line no-bitwise -- as above
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
    // eslint-disable-next-line no-bitwise -- as above
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
    // eslint-disable-next-line no-bitwise -- as above
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
    // eslint-disable-next-line no-bitwise -- as above
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

    // eslint-disable-next-line no-bitwise -- as above
    return 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
};
