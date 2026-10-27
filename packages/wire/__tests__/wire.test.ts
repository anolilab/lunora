import { describe, expect, it } from "vitest";

import { decodeDocument, decodeWire, encodeWire, needsWireEncoding, parseWire, stableStringify, stableWireKey, WIRE_TAG } from "../src";

describe("@lunora/wire", () => {
    it("round-trips values JSON cannot represent", () => {
        const value = { big: 10n, bytes: new Uint8Array([1, 2]), when: new Date(0) };
        const text = JSON.stringify(encodeWire(value));

        expect(decodeWire(JSON.parse(text))).toStrictEqual(value);
    });

    it("counts nesting depth exactly the same through arrays and plain objects", () => {
        expect.assertions(8);

        const nest = (levels: number, wrap: (inner: unknown) => unknown): unknown => {
            let value: unknown = 1;

            for (let index = 0; index < levels; index += 1) {
                value = wrap(value);
            }

            return value;
        };

        for (const wrap of [
            (inner: unknown) => [inner],
            (inner: unknown) => {
                return { inner };
            },
        ]) {
            expect(() => encodeWire(nest(64, wrap))).not.toThrow();
            expect(() => encodeWire(nest(65, wrap))).toThrow(RangeError);
            expect(() => decodeWire(nest(64, wrap))).not.toThrow();
            expect(() => decodeWire(nest(65, wrap))).toThrow(RangeError);
        }
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

    it("visits only the indices that existed when serialisation began", () => {
        expect.assertions(2);

        const growing: unknown[] = [1];
        let reads = 0;

        Object.defineProperty(growing, 0, {
            get() {
                reads += 1;
                growing.push(reads);

                return 1;
            },
        });

        expect(stableStringify(growing)).toBe("[1]");
        expect(reads).toBe(1);
    });

    it("truncates a fractional proxied length and refuses an unbounded one", () => {
        expect.assertions(2);

        const withLength = (length: number): unknown[] =>
            new Proxy([1, 2, 3], { get: (target, key, receiver) => (key === "length" ? length : (Reflect.get(target, key, receiver) as unknown)) });

        expect(stableStringify(withLength(2.5))).toBe("[1,2]");
        expect(() => stableStringify(withLength(Number.POSITIVE_INFINITY))).toThrow(RangeError);
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

describe("needsWireEncoding and array accessors", () => {
    it("sends an array with a getter element to the encoder without running the getter", () => {
        expect.assertions(2);

        let reads = 0;
        const value = [1];

        Object.defineProperty(value, 1, {
            enumerable: true,
            get: () => {
                reads += 1;

                return 2;
            },
        });

        expect(needsWireEncoding(value)).toBe(true);
        expect(reads).toBe(0);
    });
});

describe(parseWire, () => {
    const nest = (levels: number): unknown => {
        let value: unknown = 1;

        for (let index = 0; index < levels; index += 1) {
            value = { a: value };
        }

        return value;
    };

    it("decodes tagged values", () => {
        expect.assertions(2);

        const value = { at: new Date(5), id: 7n, items: [WIRE_TAG, undefined] };

        expect(parseWire(JSON.stringify(encodeWire(value)))).toStrictEqual(value);
        expect(decodeDocument(JSON.stringify(encodeWire(value)))).toStrictEqual(value);
    });

    it("decodes a document whose strings also contain the tag text", () => {
        expect.assertions(1);

        const value = { note: `see ${WIRE_TAG}`, tag: WIRE_TAG };

        expect(parseWire(JSON.stringify(encodeWire(value)))).toStrictEqual(value);
    });

    it("decodes a user array that starts with the tag text", () => {
        expect.assertions(1);

        const value = { list: [WIRE_TAG, "a"] };

        expect(parseWire(JSON.stringify(encodeWire(value)))).toStrictEqual(value);
    });

    it("returns a tagless document as parsed, without the decode's depth cap", () => {
        expect.assertions(3);

        const deep = nest(80);
        const text = JSON.stringify(deep);

        // Only the skipped decode can return this: `decodeWire` throws past 64 levels.
        expect(() => decodeWire(JSON.parse(text))).toThrow(RangeError);
        expect(parseWire(text)).toStrictEqual(deep);
        expect(decodeDocument(text)).toStrictEqual(deep);
    });

    it("keeps the depth cap when the text carries a tag", () => {
        expect.assertions(1);

        expect(() => parseWire(JSON.stringify({ deep: nest(80), tag: WIRE_TAG }))).toThrow(RangeError);
    });
});
