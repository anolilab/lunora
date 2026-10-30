import { describe, expect, it, vi } from "vitest";

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

    it("decodes a tag spelled with a JSON unicode escape", () => {
        expect.assertions(1);

        const text = JSON.stringify(encodeWire({ id: 7n })).replace("$lunora.wire$", String.raw`\u0024lunora.wire$`);

        expect(parseWire(text)).toStrictEqual({ id: 7n });
    });

    it("keeps the depth cap when the text carries a tag", () => {
        expect.assertions(1);

        expect(() => parseWire(JSON.stringify({ deep: nest(80), tag: WIRE_TAG }))).toThrow(RangeError);
    });
});

describe("one prototype read per node", () => {
    // A Proxy whose getPrototypeOf trap counts its calls and answers from a script.
    const scripted = (target: object, answers: ReadonlyArray<object | null>, extra: ProxyHandler<object> = {}) => {
        const reads = { count: 0 };
        const proxy = new Proxy(target, {
            ...extra,
            getPrototypeOf() {
                const answer = answers[Math.min(reads.count, answers.length - 1)] ?? null;

                reads.count += 1;

                return answer;
            },
        });

        return { proxy, reads };
    };

    it("reads the prototype of a date-like proxy once in each entry point", () => {
        expect.assertions(3);

        for (const run of [(value: unknown) => encodeWire(value), (value: unknown) => needsWireEncoding(value), (value: unknown) => stableStringify(value)]) {
            const { proxy, reads } = scripted(new Date(0), [Date.prototype, Object.prototype]);

            try {
                run(proxy);
            } catch {
                // rejected loudly or classified; only the read count matters here
            }

            // needsWireEncoding may answer from `toJSON` before reading at all; never twice.
            expect(reads.count).toBeLessThanOrEqual(1);
        }
    });

    it("rejects a proxy that impersonates a built-in through its traps", () => {
        expect.assertions(4);

        const fakeDate = new Proxy(new Date(5), {
            get: (target, key) => (key === "getTime" ? () => 5 : (Reflect.get(target, key) as unknown)),
            getPrototypeOf: () => Date.prototype,
        });
        const fakeMap = new Proxy(new Map([[1, 2]]), {
            get: (target, key) => (key === "entries" ? () => [[1, 2]][Symbol.iterator]() : (Reflect.get(target, key) as unknown)),
            getPrototypeOf: () => Map.prototype,
        });
        const fakeSet = new Proxy(new Set([1]), {
            getPrototypeOf: () => Set.prototype,
            get: (target, key) => (key === Symbol.iterator ? () => [1][Symbol.iterator]() : (Reflect.get(target, key) as unknown)),
        });
        const fakeBytes = new Proxy(new Uint8Array([1]), { getPrototypeOf: () => Uint8Array.prototype });

        for (const fake of [fakeDate, fakeMap, fakeSet, fakeBytes]) {
            expect(() => encodeWire(fake)).toThrow(TypeError);
        }
    });

    it("still round-trips real built-ins", () => {
        const value = {
            big: 2n ** 70n,
            buffer: new Uint8Array([1, 2, 3]).buffer,
            date: new Date(1_700_000_000_000),
            map: new Map([["a", 1n]]),
            set: new Set([1, 2]),
            view: new Float32Array([1.5]),
        };

        expect(parseWire(JSON.stringify(encodeWire(value)))).toStrictEqual(value);
    });
});

describe("brands under a polluted root prototype", () => {
    it("ignores an href accessor added to Object.prototype", async () => {
        expect.assertions(1);

        const expected = encodeWire(new Map([["a", 1]]));

        // A polluted root must not become the deepest `href` and brand every object as a URL.
        // eslint-disable-next-line no-extend-native -- the pollution under test; removed again in `finally`
        Object.defineProperty(Object.prototype, "href", { configurable: true, get: () => "https://polluted.test/" });
        vi.resetModules();

        try {
            const fresh = await import("../src");

            expect(fresh.encodeWire(new Map([["a", 1]]))).toStrictEqual(expected);
        } finally {
            Reflect.deleteProperty(Object.prototype, "href");
            vi.resetModules();
        }
    });
});

describe("date and error classification", () => {
    it("brands dates with the base getTime when a subclass overrides it without a receiver check", async () => {
        expect.assertions(2);

        const NativeDate = Date;
        const expectedMap = encodeWire(new Map([["a", 1]]));
        const expectedDate = encodeWire(new NativeDate(5));
        // A subclass whose `getTime` answers for any receiver: right for a real Date, a made-up number otherwise.
        const nativeGetTime = Reflect.get(NativeDate.prototype, "getTime");

        const LooseDate = function LooseDate(...arguments_: ConstructorParameters<typeof Date>): Date {
            return Reflect.construct(NativeDate, arguments_, LooseDate) as Date;
        };

        LooseDate.prototype = Object.create(NativeDate.prototype, {
            getTime: {
                value(this: unknown): number {
                    try {
                        return Reflect.apply(nativeGetTime, this, []);
                    } catch {
                        return 0;
                    }
                },
            },
        }) as Date;
        Object.setPrototypeOf(LooseDate, NativeDate);
        vi.stubGlobal("Date", LooseDate);
        vi.resetModules();

        try {
            const fresh = await import("../src");

            expect(fresh.encodeWire(new Map([["a", 1]]))).toStrictEqual(expectedMap);
            expect(fresh.encodeWire(new NativeDate(5))).toStrictEqual(expectedDate);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });
});

describe("url classification", () => {
    it("encodes a url when the global URL is a subclass that inherits href", async () => {
        expect.assertions(1);

        const NativeUrl = URL;
        const expected = encodeWire(new NativeUrl("https://a.test/path"));

        class SubUrl extends NativeUrl {}

        vi.stubGlobal("URL", SubUrl);
        vi.resetModules();

        try {
            const fresh = await import("../src");

            expect(fresh.encodeWire(new SubUrl("https://a.test/path"))).toStrictEqual(expected);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });

    it("brands urls with the base getter when a subclass overrides href without a receiver check", async () => {
        expect.assertions(1);

        const NativeUrl = URL;
        const expected = encodeWire(new Map([["a", 1]]));

        // A subclass whose `href` answers for any receiver: right for a real URL, a made-up string otherwise.
        const LooseUrl = function LooseUrl(...arguments_: ConstructorParameters<typeof URL>) {
            return Reflect.construct(NativeUrl, arguments_, LooseUrl) as URL;
        } as unknown as typeof URL;

        LooseUrl.prototype = Object.create(NativeUrl.prototype, {
            href: {
                get(this: unknown): string {
                    try {
                        return Reflect.get(NativeUrl.prototype, "href", this);
                    } catch {
                        return "https://loose.test/";
                    }
                },
            },
        }) as URL;
        Object.setPrototypeOf(LooseUrl, NativeUrl);

        vi.stubGlobal("URL", LooseUrl);
        vi.resetModules();

        try {
            const fresh = await import("../src");

            expect(fresh.encodeWire(new Map([["a", 1]]))).toStrictEqual(expected);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });
});
