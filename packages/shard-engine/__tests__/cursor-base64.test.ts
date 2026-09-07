import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, fromBase64, toBase64 } from "../src/query-args";

/**
 * `toBase64` short-circuits an all-ASCII string straight to `btoa`, on the
 * grounds that such a string IS its own UTF-8 byte sequence and `btoa` already
 * takes a latin-1 string — so the `TextEncoder` pass and the byte-by-byte
 * rebuild are both the identity for it.
 *
 * Cursors are opaque and CLIENT-HELD: a client pages with the cursor the server
 * handed it, possibly across a deploy. So the fast path has to produce the same
 * bytes as the slow one, not merely something that round-trips — a cursor
 * encoded by one path and decoded by the other must agree, or pagination breaks
 * across a rollout for exactly the ids that changed representation.
 */

/** The pre-fast-path encoder, verbatim. */
const reference = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

describe("cursor base64", () => {
    it.each([
        ["empty", ""],
        ["plain ascii", '[1700000000000,"m12345"]'],
        ["every ascii code point", Array.from({ length: 128 }, (_value, index) => String.fromCodePoint(index)).join("")],
        ["accented id", '[1700000000000,"café_1"]'],
        ["cjk id", '[1700000000000,"用户_12345"]'],
        ["emoji id", '[1700000000000,"user_🎉"]'],
        ["mixed", '[1700000000000,"ascii-then-café"]'],
    ])("encodes %s byte-identically to the full path", (_label, text) => {
        expect.assertions(2);

        expect(toBase64(text)).toBe(reference(text));
        // And it must survive the round trip, which is what a paging client does.
        expect(fromBase64(toBase64(text))).toBe(text);
    });

    it("round-trips a cursor whose id is not ascii", () => {
        expect.assertions(1);

        // The id lands in the cursor verbatim, so a non-ASCII document id is the
        // realistic way the slow path gets exercised in production.
        const keys = [{ direction: "asc" as const, field: "_creationTime", nullable: false }];
        const record = { _creationTime: 1_700_000_000_000, _id: "用户_42" };

        expect(decodeCursor(encodeCursor(record, keys))).toStrictEqual([1_700_000_000_000, "用户_42"]);
    });
});
