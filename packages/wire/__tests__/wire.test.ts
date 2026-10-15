import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire, stableStringify, stableWireKey } from "../src";

describe("@lunora/wire", () => {
    it("round-trips values JSON cannot represent", () => {
        const value = { big: 10n, bytes: new Uint8Array([1, 2]), when: new Date(0) };
        const text = JSON.stringify(encodeWire(value));

        expect(decodeWire(JSON.parse(text))).toStrictEqual(value);
    });

    it("builds a key independent of object key order", () => {
        expect(stableWireKey({ a: 1n, b: 2 })).toBe(stableWireKey({ b: 2, a: 1n }));
    });
});

describe("stableStringify arrays", () => {
    it("serialises indexed elements, not a custom iterator", () => {
        expect.assertions(2);

        const indexed = [1, 2, 3];

        Object.defineProperty(indexed, Symbol.iterator, {
            value: function* customIterator() {
                yield 9;
            },
        });

        expect(stableStringify(indexed)).toBe("[1,2,3]");
        expect(stableStringify([1, 2, 3])).toBe(stableStringify(indexed));
    });

    it("visits sparse holes as null and keeps a sparse array distinct from an empty one", () => {
        expect.assertions(3);

        // eslint-disable-next-line no-sparse-arrays -- the hole is the point of the test
        expect(stableStringify([, 1])).toBe("[null,1]");
        expect(stableStringify(Array.from({ length: 1 }))).toBe("[null]");
        expect(stableWireKey(Array.from({ length: 1 }))).not.toBe(stableWireKey([]));
    });
});
