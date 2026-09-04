import { isLunoraError, LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire, WIRE_TAG } from "../../../shared/wire-codec";

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

    it("round-trips Date (which the plain-object branch would drop to {})", () => {
        expect.assertions(3);

        const date = new Date("2026-07-02T12:34:56.789Z");

        // A Date has no own enumerable keys, so without a dedicated tag the codec's
        // plain-object branch would silently encode it to `{}` — total data loss.
        const decoded = wire({ at: date }) as { at: Date };

        expect(decoded.at).toBeInstanceOf(Date);
        expect(decoded.at.getTime()).toBe(date.getTime());

        // An invalid Date round-trips as an invalid Date (NaN epoch), not `{}`.
        expect(Number.isNaN((wire(new Date("nope")) as Date).getTime())).toBe(true);
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

        // The sentinel is a distinctive string; an app could still send it as data.
        const hostile = ["$lunora.wire$", "bigint", "not-a-real-tag", 1n];

        expect(wire(hostile)).toStrictEqual(hostile);
    });

    it("round-trips Error (name/message/own props) which the object branch would drop to {}", () => {
        expect.assertions(5);

        // name, message and stack are all non-enumerable, so without a dedicated
        // tag the codec would drop them and yield a bare {} (only custom props).
        const source = Object.assign(new TypeError("boom"), { code: "E_BOOM", detail: 7n });
        const decoded = wire({ err: source }) as { err: TypeError & { code?: string; detail?: bigint } };

        expect(decoded.err).toBeInstanceOf(TypeError);
        expect(decoded.err.message).toBe("boom");
        expect(decoded.err.name).toBe("TypeError");
        expect(decoded.err.code).toBe("E_BOOM");
        // own props round-trip through the codec too (bigint survives).
        expect(decoded.err.detail).toBe(7n);
    });

    it("restores a custom Error subclass name via the generic Error fallback", () => {
        expect.assertions(3);

        // A subclass whose ctor is not on the allow-list (e.g. a server LunoraError)
        // rebuilds as a generic Error with its `.name` and `.message` preserved.
        const source = new LunoraError("INTERNAL", "nope");
        const decoded = wire(source) as Error;

        expect(decoded).toBeInstanceOf(Error);
        expect(decoded.name).toBe("LunoraError");
        expect(decoded.message).toBe("nope");
    });

    it("round-trips a LunoraError with its wire brand intact (isLunoraError twin)", () => {
        expect.assertions(2);

        const source = new LunoraError("CONFLICT", "stale");
        const decoded = wire(source) as LunoraError;

        expect(isLunoraError(decoded)).toBe(true);
        expect(decoded.message).toBe("stale");
    });

    it("round-trips an Error `cause` chain (non-enumerable, positional slot)", () => {
        expect.assertions(3);

        const source = new Error("outer", { cause: Object.assign(new RangeError("inner"), { code: "E_INNER" }) });
        const decoded = wire(source) as Error & { cause?: RangeError & { code?: string } };

        expect(decoded.message).toBe("outer");
        expect(decoded.cause).toBeInstanceOf(RangeError);
        expect(decoded.cause?.code).toBe("E_INNER");
    });

    it("does not let a wire __proto__ key in an error's props swap the reconstructed error's prototype", () => {
        expect.assertions(4);

        // The error decode branch merges the wire props object onto the freshly
        // constructed Error. `JSON.parse` makes `__proto__` an OWN key, so a bare
        // `Object.assign(error, props)` would fire the prototype setter and swap
        // the Error's prototype (Cap'n Web #190, error-branch variant).
        const tag = (encodeWire(1n) as string[])[0];
        // Build the wire tuple [TAG, "error", name, message, propsObject]; the props
        // object carries `__proto__` as an OWN key (JSON.parse), routed through the
        // real JSON transport the codec exists to survive.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- must exercise the real JSON transport, which is what the codec decodes
        const wireError = JSON.parse(JSON.stringify([tag, "error", "Error", "boom", JSON.parse('{"__proto__":{"polluted":true},"code":"E_BOOM"}')]));
        const decoded = decodeWire(wireError) as Error & { code?: string };

        // Prototype untouched — the reconstructed value is still a real Error.
        expect(Object.getPrototypeOf(decoded)).toBe(Error.prototype);
        expect(decoded).toBeInstanceOf(Error);
        // The `__proto__` value round-trips as an own data prop, not a prototype swap.
        expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toStrictEqual({ polluted: true });
        // Ordinary custom props still merge onto the error (regression).
        expect(decoded.code).toBe("E_BOOM");
    });

    it("round-trips Map and Set (contents recurse, so bigint/bytes survive)", () => {
        expect.assertions(4);

        const map = wire(
            new Map<string, unknown>([
                ["b", new Uint8Array([1, 2])],
                ["n", 42n],
            ]),
        ) as Map<string, unknown>;

        expect(map).toBeInstanceOf(Map);
        expect(map.get("n")).toBe(42n);

        const set = wire(new Set([1n, "x"])) as Set<unknown>;

        expect(set).toBeInstanceOf(Set);
        expect(set.has(1n)).toBe(true);
    });

    it("round-trips a URL", () => {
        expect.assertions(2);

        const decoded = wire(new URL("https://lunora.sh/docs?q=1#top")) as URL;

        expect(decoded).toBeInstanceOf(URL);
        expect(decoded.href).toBe("https://lunora.sh/docs?q=1#top");
    });

    it("fails loud on other non-plain objects (RegExp / Headers / WeakMap) instead of silent {}", () => {
        expect.assertions(3);

        // Non-plain objects with no own enumerable keys would collapse to `{}`; the
        // prototype-based guard rejects them at the send site.
        expect(() => encodeWire({ re: /ab+c/g })).toThrow(TypeError);
        expect(() => encodeWire(new Headers({ "x-a": "1" }))).toThrow(TypeError);
        expect(() => encodeWire(new WeakMap())).toThrow(TypeError);
    });

    it("throws a RangeError past the nesting-depth cap instead of blowing the stack", () => {
        expect.assertions(3);

        // Build nesting well past the 64-level cap (both array and object forms).
        let deepArray: unknown = 1;

        for (let index = 0; index < 200; index += 1) {
            deepArray = [deepArray];
        }

        let deepObject: unknown = { leaf: 1 };

        for (let index = 0; index < 200; index += 1) {
            deepObject = { nested: deepObject };
        }

        expect(() => encodeWire(deepArray)).toThrow(RangeError);
        expect(() => encodeWire(deepObject)).toThrow(RangeError);

        // Decode is guarded too: a hand-crafted deep JSON array (what an untrusted
        // peer could send) is rejected rather than recursing unbounded on decode.
        const deepJson = JSON.parse(`${"[".repeat(200)}1${"]".repeat(200)}`);

        expect(() => decodeWire(deepJson)).toThrow(RangeError);
    });

    it("allows nesting up to the cap", () => {
        expect.assertions(1);

        // 60 levels — comfortably under the 64 cap — must still round-trip.
        let value: unknown = 42n;

        for (let index = 0; index < 60; index += 1) {
            value = [value];
        }

        expect(wire(value)).toStrictEqual(value);
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

    it("does not let a wire __proto__ key pollute the decoded object (Cap'n Web #190)", () => {
        expect.assertions(4);

        // What an untrusted peer could send — `JSON.parse` makes `__proto__` an OWN
        // key, so a naive assign would fire the prototype setter and pollute.
        const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
        const decoded = decodeWire(hostile) as Record<string, unknown>;

        // Prototype untouched — no pollution of the decoded object or the global.
        expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        // Real data survives; the `__proto__` value round-trips as an own data prop.
        expect(decoded.a).toBe(1);
        expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    });

    it("rejects an over-long or non-numeric wire bigint (DoS-safe decode, Cap'n Web #185)", () => {
        expect.assertions(4);

        // `BigInt()`'s decimal parse is superlinear — a huge digit string would
        // block the event loop, so decode bounds + validates it first.
        const tag = (encodeWire(1n) as string[])[0];

        expect(() => decodeWire([tag, "bigint", "9".repeat(2000)])).toThrow(RangeError);
        expect(() => decodeWire([tag, "bigint", "12x34"])).toThrow(RangeError);
        expect(() => decodeWire([tag, "bigint", 123])).toThrow(RangeError);
        // A normal bigint still round-trips.
        expect(wire(-42n)).toBe(-42n);
    });

    // The decode side has always preserved a literal `__proto__` field (as an own
    // data property, via `defineProperty`). The encode side did not: a plain
    // `result[key] = …` fires the prototype SETTER for that key, so the field
    // vanished. A document read with `JSON.parse` — which makes `__proto__` an
    // OWN key — therefore lost it on every re-encode, silently.
    it("round-trips a literal __proto__ field instead of dropping it on encode", () => {
        expect.assertions(4);

        // `JSON.parse` is how such a document actually arrives; an object literal
        // would set the prototype rather than create the key.
        const document = JSON.parse('{"__proto__":{"polluted":true},"amount":7}') as Record<string, unknown>;

        expect(Object.keys(document)).toStrictEqual(["__proto__", "amount"]);

        const encoded = encodeWire(document) as Record<string, unknown>;

        expect(Object.keys(encoded)).toStrictEqual(["__proto__", "amount"]);

        // eslint-disable-next-line unicorn/prefer-structured-clone -- simulating the JSON wire, not cloning: `structuredClone` preserves values JSON drops, which would defeat the round-trip this asserts
        const decoded = decodeWire(JSON.parse(JSON.stringify(encoded))) as Record<string, unknown>;

        expect(Object.keys(decoded)).toStrictEqual(["__proto__", "amount"]);
        // And nothing was polluted along the way — the key is an own data
        // property, so no object in the chain gained a `polluted` member.
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });

    // Same defect, one branch over: the ERROR encode branch built its props object
    // with a plain `properties[key] = …`, so an error carrying a literal `__proto__`
    // own prop (which `decodeWire` faithfully produces) re-encoded as `{}` — and the
    // props object itself came back with a wire-chosen prototype, which `JSON.stringify`
    // hides. The decode side and the plain-object encode branch both already guarded it.
    it("round-trips a literal __proto__ prop on an error instead of dropping it on encode", () => {
        expect.assertions(4);

        // eslint-disable-next-line unicorn/prefer-structured-clone -- must exercise the real JSON transport, which is what the codec decodes
        const frame = JSON.parse(JSON.stringify([WIRE_TAG, "error", "Error", "boom", JSON.parse('{"__proto__":{"polluted":true},"code":"E_BOOM"}')]));
        const decoded = decodeWire(frame) as Error;

        const encoded = encodeWire(decoded) as unknown[];
        const properties = encoded[4] as Record<string, unknown>;

        expect(Object.keys(properties)).toStrictEqual(["__proto__", "code"]);
        // The props object is a plain object, not one wearing the wire's prototype.
        expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
        // And the whole frame is a fixed point of the round trip.
        expect(encoded).toStrictEqual(frame);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});
