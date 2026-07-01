import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";

/** JSON round-trip of the encoded form, mirroring what the transport actually does. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- must exercise the real JSON transport (structuredClone wouldn't serialize, nor throw on bigint), which is exactly what the codec exists to survive
const wire = (value: unknown): unknown => decodeWire(JSON.parse(JSON.stringify(encodeWire(value))));

describe("wireCodec round-trips", () => {
    it("passes plain JSON through byte-identically (back-compat)", () => {
        expect.assertions(2);

        const value = { a: 1, b: "two", c: true, d: null, e: [1, 2, 3], f: { g: [{ h: "i" }] } };

        // A value with no special leaves must encode to the same JSON bytes a
        // pre-codec peer would send, so old/new peers interop on pure JSON.
        expect(JSON.stringify(encodeWire(value))).toBe(JSON.stringify(value));
        expect(wire(value)).toStrictEqual(value);
    });

    it("round-trips bigint (which JSON.stringify would throw on)", () => {
        expect.assertions(2);

        expect(() => JSON.stringify({ n: 42n })).toThrow(TypeError);
        expect(wire({ n: 42n, big: 9_007_199_254_740_993n })).toStrictEqual({ n: 42n, big: 9_007_199_254_740_993n });
    });

    it("round-trips ArrayBuffer (which JSON.stringify would drop to {})", () => {
        expect.assertions(2);

        const { buffer } = new Uint8Array([1, 2, 3, 250, 0, 255]);

        expect(JSON.stringify({ b: buffer })).toBe('{"b":{}}');

        const decoded = wire({ b: buffer }) as { b: ArrayBuffer };

        expect([...new Uint8Array(decoded.b)]).toStrictEqual([1, 2, 3, 250, 0, 255]);
    });

    it("round-trips Uint8Array with the 2-element back-compat form", () => {
        expect.assertions(2);

        const bytes = new Uint8Array([9, 8, 7]);
        const encoded = encodeWire(bytes) as unknown[];

        expect(encoded).toHaveLength(3); // [TAG, "bytes", b64] — no ctor name for Uint8Array

        const decoded = wire(bytes) as Uint8Array;

        expect([...decoded]).toStrictEqual([9, 8, 7]);
    });

    it("round-trips other typed-array views carrying their constructor name", () => {
        expect.assertions(2);

        const floats = new Float32Array([1.5, -2.25, 3.75]);
        const decoded = wire(floats) as Float32Array;

        expect(decoded).toBeInstanceOf(Float32Array);
        expect([...decoded]).toStrictEqual([1.5, -2.25, 3.75]);
    });

    it("round-trips NaN / Infinity / -Infinity (which JSON coerces to null)", () => {
        expect.assertions(1);

        expect(wire({ a: Number.NaN, b: Infinity, c: -Infinity })).toStrictEqual({ a: Number.NaN, b: Infinity, c: -Infinity });
    });

    it("preserves undefined in array positions but drops undefined object fields", () => {
        expect.assertions(2);

        // Array positions keep undefined (JSON would coerce to null, losing info).
        expect(wire([1, undefined, 3])).toStrictEqual([1, undefined, 3]);

        // Object fields set to undefined are dropped (matches JSON.stringify), so
        // plain objects stay byte-identical.
        expect(wire({ a: 1, b: undefined })).toStrictEqual({ a: 1 });
    });

    it("escapes a user array that literally starts with the sentinel string", () => {
        expect.assertions(1);

        // The sentinel begins with a space; an app could still send it as data.
        const hostile = [" lunora.wire", "bigint", "not-a-real-tag", 1n];

        expect(wire(hostile)).toStrictEqual(hostile);
    });

    it("handles deep nesting of mixed special and plain values", () => {
        expect.assertions(1);

        const value = {
            id: "doc_1",
            embedding: new Float32Array([0.1, 0.2]),
            meta: { count: 10n, blob: new Uint8Array([1, 2]).buffer, tags: ["a", undefined, "c"] },
            list: [1n, { nested: new Uint8Array([255]) }],
        };

        expect(wire(value)).toStrictEqual(value);
    });
});
