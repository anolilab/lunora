import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../../../shared/base64";
import { signCanonical } from "../../../shared/hmac-url";

/**
 * `toBase64Url` is on two paths where the exact bytes are the contract, not an
 * implementation detail:
 *
 * HMAC signatures for presigned/signed URLs: a URL handed to a client outlives
 * any deploy, so a signature produced before a change must still verify after it.
 * Round-trip tests cannot see a break here — if sign and verify both move to a
 * new encoding they agree with each other and disagree with every URL already in
 * the wild.
 *
 * The `x-lunora-identity` / `x-lunora-userid` headers, which cross the worker to
 * shard boundary and can be produced and consumed by different builds during a
 * rollout.
 *
 * So this pins literal expected output rather than asserting a round-trip.
 */

describe("base64url encoding is stable", () => {
    it("encodes the RFC 4648 test vectors unpadded, with the URL-safe alphabet", () => {
        expect.assertions(7);

        const encode = (text: string) => toBase64Url(new TextEncoder().encode(text));

        // RFC 4648 §10, minus the padding this variant does not emit.
        expect(encode("")).toBe("");
        expect(encode("f")).toBe("Zg");
        expect(encode("fo")).toBe("Zm8");
        expect(encode("foo")).toBe("Zm9v");
        expect(encode("foob")).toBe("Zm9vYg");
        expect(encode("fooba")).toBe("Zm9vYmE");
        expect(encode("foobar")).toBe("Zm9vYmFy");
    });

    it("uses - and _ rather than + and /, for the bytes that produce them", () => {
        expect.assertions(2);

        // 0xFB 0xFF 0xFE is `+//+` in standard base64; every one of those four
        // characters exercises the alphabet swap.
        const encoded = toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]));

        expect(encoded).toBe("-__-");
        expect(encoded).not.toMatch(/[+/=]/);
    });

    it("round-trips every byte value and every 3-byte residue class", () => {
        expect.assertions(3);

        const all = new Uint8Array(256);

        for (let index = 0; index < 256; index += 1) all[index] = index;

        // 256 % 3 === 1, so slicing off 0/1/2 bytes covers all three tail cases.
        for (const drop of [0, 1, 2]) {
            const bytes = all.subarray(0, all.length - drop);

            expect([...fromBase64Url(toBase64Url(bytes))]).toStrictEqual([...bytes]);
        }
    });

    it("produces the signature an earlier build produced for the same input", async () => {
        expect.assertions(1);

        // Golden, not a round-trip: computed from the implementation this
        // replaced, then checked against the new one. If the encoder drifts,
        // every signed URL already issued stops verifying, and this is the only
        // test that says so.
        await expect(signCanonical("test-secret-value", "GET\nbucket.example\n/objects/report.pdf\n1700000000")).resolves.toBe(
            // eslint-disable-next-line no-secrets/no-secrets -- an HMAC of a fixed public test string, not a credential; its entropy is the point
            "l_zh1cHA76vO1immXHNSBjFCRSGZCiwVtT4Nuc5yC9o",
        );
    });
});
