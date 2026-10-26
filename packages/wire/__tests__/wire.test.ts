import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire, needsWireEncoding, stableStringify, stableWireKey } from "../src";

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

const FUNCTION_ERROR = /function/u;
const SYMBOL_ERROR = /symbol/u;

describe("stableStringify values JSON cannot encode", () => {
    it("throws for a function or symbol instead of returning undefined", () => {
        expect.assertions(2);

        // `JSON.stringify(fn)` is `undefined`, so these used to come back as a
        // non-string — or, inside an object, as the text "undefined".
        expect(() => stableStringify(() => 1)).toThrow(TypeError);
        expect(() => stableStringify(Symbol("s"))).toThrow(TypeError);
    });

    it("does not let distinct arguments collide on one key", () => {
        expect.assertions(3);

        expect(() => stableStringify({ cb: () => 1 })).toThrow(FUNCTION_ERROR);
        expect(() => stableStringify([Symbol("a")])).toThrow(SYMBOL_ERROR);
        expect(stableStringify({ a: undefined })).toBe(stableStringify({}));
    });
});

describe("needsWireEncoding and toJSON", () => {
    it("sends a value with a toJSON to the encoder, where JSON.stringify would call it and encodeWire would not", () => {
        expect.assertions(5);

        const hidden = Object.defineProperty({ visible: 1 }, "toJSON", { enumerable: false, value: () => "replaced" });

        expect(needsWireEncoding({ visible: 1 })).toBe(false);
        expect(needsWireEncoding(hidden)).toBe(true);
        expect(needsWireEncoding({ nested: [hidden] })).toBe(true);
        expect(needsWireEncoding(Object.assign([1, 2], { toJSON: () => "replaced" }))).toBe(true);
        expect(needsWireEncoding(Object.create({ toJSON: () => "inherited" }) as object)).toBe(true);
    });

    it("does not run a toJSON getter, which encodeWire would never read", () => {
        expect.assertions(2);

        const value = Object.defineProperty({ visible: 1 }, "toJSON", {
            enumerable: false,
            get: () => {
                throw new Error("read");
            },
        });

        expect(needsWireEncoding(value)).toBe(true);
        expect(encodeWire(value)).toStrictEqual({ visible: 1 });
    });
});
