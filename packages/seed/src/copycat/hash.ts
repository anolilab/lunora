/**
 * Deterministic input hashing for the internal `copycat` generator.
 *
 * Every generator method turns its `input` (any JSON-serializable value) into a
 * stable 32-bit seed via {@link hashInput}, then drives a per-call seeded faker.
 * The contract — identical input ⇒ identical output, forever, regardless of call
 * order or object key order — mirrors `@snaplet/copycat`. We do not need
 * copycat's SipHash (that exists for anonymization, to make outputs
 * non-reversible); for seeding a well-distributed avalanche hash is sufficient,
 * with an optional module-level key for those who do want output variation.
 */

/* eslint-disable no-bitwise -- cyrb53 and the key-folding are defined over XOR and unsigned shifts; the bit ops ARE the algorithm */

/** Module-level salt mixed into every hash; overridden by {@link setHashKey}. */
let hashSalt = 0;

/** Code-unit string comparison for a stable, locale-independent key sort. */
const compareStrings = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    if (a > b) {
        return 1;
    }

    return 0;
};

/**
 * Stable JSON stringification: object keys are emitted in sorted order so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash identically (copycat parity).
 * `bigint` is serialized as its decimal string (plain `JSON.stringify` throws on
 * it); `undefined` becomes the literal `"undefined"` so it is distinguishable.
 *
 * This is an INTENTIONAL fork of the canonical `shared/stable-key.ts` encoder —
 * do not consolidate the two. copycat's deterministic-seed hash domain depends on
 * this exact encoding: `undefined` must stay distinguishable (the shared encoder
 * skips `undefined` object fields), `bigint` must serialize, and outputs must
 * never start with `U+0000` (see {@link STRING_DOMAIN_TAG}). Different contracts.
 */
const stableStringify = (input: unknown): string => {
    if (input === undefined) {
        return "undefined";
    }

    if (typeof input === "bigint") {
        return `${input.toString()}n`;
    }

    if (input === null || typeof input !== "object") {
        // JSON.stringify is typed to return string but yields undefined for symbol/function inputs.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runtime value can be undefined despite the type
        return JSON.stringify(input) ?? "null";
    }

    if (Array.isArray(input)) {
        return `[${input.map((item) => stableStringify(item)).join(",")}]`;
    }

    const entries = Object.keys(input as Record<string, unknown>)
        .toSorted(compareStrings)
        .map((key) => `${JSON.stringify(key)}:${stableStringify((input as Record<string, unknown>)[key])}`);

    return `{${entries.join(",")}}`;
};

/**
 * A cyrb53 string hash — fast, well-distributed, 53-bit, with good avalanche
 * behaviour. Public-domain (bryc). Two independent accumulators seeded from
 * `seed` are mixed and combined; we down-fold the 53-bit result to an unsigned
 * 32-bit integer for faker's seed.
 */
const cyrb53 = (text: string, seed: number): number => {
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

/**
 * Domain sentinel for the raw-string fast path. A bare string is hashed
 * directly (skipping {@link stableStringify}) for speed, but that means a string
 * input whose text happens to equal a non-string's serialized form would collide
 * — e.g. the string `"[1,2]"` vs the array `[1, 2]` (which serializes to
 * `[1,2]`). We disambiguate by prefixing every raw string with this control
 * character (`U+0000`), which {@link stableStringify} can never emit at the start
 * of a non-string's output (its outputs begin with `"`, `[`, `{`, a digit, `-`,
 * or one of the literals `undefined`/`null`/`true`/`false`). Strings and
 * non-strings therefore occupy disjoint hash domains.
 */
const STRING_DOMAIN_TAG = "\u0000";

/**
 * Hash any JSON-serializable `input` to an unsigned 32-bit integer usable as a
 * faker seed. Stable across calls and process restarts; sensitive to the active
 * {@link setHashKey} salt.
 */
const hashInput = (input: unknown): number => {
    const text = typeof input === "string" ? STRING_DOMAIN_TAG + input : stableStringify(input);

    return cyrb53(text, hashSalt) % 0x1_00_00_00_00;
};

/**
 * Override the global hash salt so generated values shift to a different (but
 * still deterministic) mapping. Accepts a string secret or a {@link Uint32Array}
 * key. Pass `0` / an empty string to reset.
 */
const setHashKey = (key: number | string | Uint32Array): void => {
    if (typeof key === "number") {
        hashSalt = key >>> 0;

        return;
    }

    if (typeof key === "string") {
        hashSalt = cyrb53(key, 0) % 0x1_00_00_00_00;

        return;
    }

    // Fold the key words into a single 32-bit salt.
    let folded = 0;

    for (const word of key) {
        folded = Math.imul(folded ^ word, 2_654_435_761) >>> 0;
    }

    hashSalt = folded;
};

/* eslint-enable no-bitwise */

export { hashInput, setHashKey, stableStringify };
