import { decodeWire, WIRE_TAG } from "@lunora/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeDocJson, encodeDocJson } from "../src/do-sql";

// Spied, not replaced: the decode still runs, so the value assertions keep checking correctness.
vi.mock(import("@lunora/wire"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, decodeWire: vi.fn(actual.decodeWire) };
});

describe("decodeDocJson", () => {
    beforeEach(() => {
        vi.mocked(decodeWire).mockClear();
    });

    it("revives wire-tagged leaves, top-level and nested", () => {
        expect.assertions(2);

        const document = { at: new Date(5), n: 7n, nested: { bytes: new Uint8Array([1, 2]), when: new Date(9) } };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
        expect(decodeWire).toHaveBeenCalledTimes(1);
    });

    it("returns a plain row as parsed, without running the wire decode", () => {
        expect.assertions(2);

        const document = { list: [1, "two", { three: null }], name: "plain" };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
        // The skip is the point of the fast path: a plain row must not pay for `decodeWire`.
        expect(decodeWire).not.toHaveBeenCalled();
    });

    it("keeps a string that merely contains the tag text", () => {
        expect.assertions(1);

        const document = { label: `${WIRE_TAG} is just text`, pair: [WIRE_TAG, "not-a-kind"] };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
    });

    it("revives a frame whose tag is written with JSON unicode escapes", () => {
        expect.assertions(1);

        const raw = String.raw`{"n":["\u0024lunora.wire$","bigint","1"]}`;

        expect(decodeDocJson(raw)).toStrictEqual({ n: 1n });
    });
});
