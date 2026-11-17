/**
 * The fingerprint of the verified claims a socket's values are read under, shared by everything that has to
 * agree on it: the shard stamps it on a socket's `identity` frame, a client echoes it back when it resubscribes
 * from a cursor, and the shard compares it with the socket's current claims. A client never computes one and
 * never says what is fingerprinted, so it can only hand back what the shard told it.
 *
 * Synchronous on purpose: it runs on the frame path of a Durable Object, where an awaited digest would let the
 * next frame of the same socket run first. SHA-256 is written out here for that reason, since `crypto.subtle` is async.
 */

import { toBase64Url } from "./base64";

/** Claims a refreshed credential re-issues on every refresh; they say when it was minted and until when, not who it names. */
const VOLATILE_CLAIMS = new Set(["exp", "expiresAtMs", "iat", "jti", "nbf"]);

const canonical = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonical(item)).join(",")}]`;
    }

    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    }

    return JSON.stringify(value) ?? "null";
};

/**
 * The claims that must stay unchanged for a socket's identity to be the same, as one comparable string (`""` for none).
 * Key order and the volatile claims do not matter.
 */
const canonicalClaims = (identity: Record<string, unknown> | undefined): string => {
    const stable = Object.fromEntries(Object.entries(identity ?? {}).filter(([claim]) => !VOLATILE_CLAIMS.has(claim)));

    return Object.keys(stable).length === 0 ? "" : canonical(stable);
};

const K = new Uint32Array([
    0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
    0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
    0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
    0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
    0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
    0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
    0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of `bytes`. */
const sha256 = (bytes: Uint8Array): Uint8Array => {
    const hash = new Uint32Array([0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19]);
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);

    padded.set(bytes);
    padded[bytes.length] = 0x80;

    const view = new DataView(padded.buffer);

    view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);

    const schedule = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            schedule[index] = view.getUint32(offset + index * 4);
        }

        for (let index = 16; index < 64; index += 1) {
            const w15 = schedule[index - 15] as number;
            const w2 = schedule[index - 2] as number;
            const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
            const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);

            schedule[index] = ((schedule[index - 16] as number) + s0 + (schedule[index - 7] as number) + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash as unknown as [number, number, number, number, number, number, number, number];

        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choose + (K[index] as number) + (schedule[index] as number)) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        [a, b, c, d, e, f, g, h].forEach((word, index) => {
            hash[index] = ((hash[index] as number) + word) >>> 0;
        });
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);

    hash.forEach((word, index) => {
        outView.setUint32(index * 4, word);
    });

    return out;
};

/**
 * A short opaque fingerprint of who a socket is and the claims it holds: the user id and every non-volatile claim.
 * Equal claims give equal fingerprints whatever their key order; the claims themselves are not recoverable from it.
 * @returns 16 bytes of SHA-256, base64url
 */
const claimsFingerprint = (userId: string | undefined, identity: Record<string, unknown> | undefined): string =>
    toBase64Url(sha256(new TextEncoder().encode(`${JSON.stringify(userId ?? null)}|${canonicalClaims(identity)}`)).subarray(0, 16));

export { canonicalClaims, claimsFingerprint, sha256 };
