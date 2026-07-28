import { describe, expect, it } from "vitest";

import { highlightSegments } from "../../../src/features/data/data-grid";

/** The matched substrings, in order — what the operator actually sees marked. */
const matched = (text: string, needle: string): string[] =>
    highlightSegments(text, needle)
        .filter((segment) => segment.match)
        .map((segment) => segment.text);

/** Reassembling every segment must reproduce the input exactly. */
const roundTrip = (text: string, needle: string): string =>
    highlightSegments(text, needle)
        .map((segment) => segment.text)
        .join("");

describe("highlightSegments", () => {
    it("marks every occurrence, preserving the original casing", () => {
        expect.assertions(2);

        expect(matched("Alice and alice", "alice")).toStrictEqual(["Alice", "alice"]);
        // Case-insensitive matching must not rewrite what is displayed.
        expect(roundTrip("Alice and alice", "alice")).toBe("Alice and alice");
    });

    it("never loses or duplicates text, whatever the match layout", () => {
        expect.assertions(4);

        // A dropped or repeated character here would be a visible corruption of
        // the cell, which is worse than not highlighting at all.
        expect(roundTrip("aaa", "a")).toBe("aaa");
        expect(roundTrip("abcabc", "bc")).toBe("abcabc");
        expect(roundTrip("no match here", "zzz")).toBe("no match here");
        expect(roundTrip("", "x")).toBe("");
    });

    it("returns the whole text as one unmatched run for an empty needle", () => {
        expect.assertions(2);

        const segments = highlightSegments("hello", "");

        expect(segments).toHaveLength(1);
        expect(segments[0]?.match).toBe(false);
    });

    it("handles a needle at both ends", () => {
        expect.assertions(2);

        expect(matched("xhellox", "x")).toStrictEqual(["x", "x"]);
        expect(roundTrip("xhellox", "x")).toBe("xhellox");
    });
});
