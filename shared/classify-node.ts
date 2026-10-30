/**
 * What a non-null object is, decided from ONE `Object.getPrototypeOf` read.
 *
 * A Proxy's `getPrototypeOf` trap may answer differently on each call, so any
 * code that asks "plain?" and then "Date?" separately can see two different
 * objects. Classifying once and acting on the verdict removes that window.
 *
 * - `array` / `plain` are the fast paths and cost one prototype read.
 * - `builtin` names a supported built-in, recognised by its internal slot
 *   (a method or getter that throws unless called on the real thing), never by
 *   `instanceof`, so a Proxy or a look-alike can not pass as one.
 * - `other` is everything else (a class instance, a Proxy, a RegExp, ...).
 *
 * Bundler-inlined; zero dependencies.
 */
export type NodeKind =
    "array" | "builtin-array-buffer" | "builtin-date" | "builtin-error" | "builtin-map" | "builtin-set" | "builtin-url" | "builtin-view" | "other" | "plain";

const brand = (check: () => unknown): boolean => {
    try {
        check();

        return true;
    } catch {
        return false;
    }
};

/*
 * Every brand is the DEEPEST definition of its name on the chain, read once at module load. When a global is a
 * subclass, the base class's member is the one that checks its receiver's internal slot; an override above it may
 * answer for any object (a Map would then pass as a URL or a Date), so it is never the brand. The walk stops at the
 * shared roots: a member planted on `Object.prototype` or `Function.prototype` is inherited by everything, so it
 * would brand every object.
 */
const SHARED_ROOTS: ReadonlySet<object> = new Set([Object.prototype, Function.prototype]);

const deepest = (start: object, key: string, part: "get" | "value"): (() => unknown) | undefined => {
    let found: (() => unknown) | undefined;

    for (let current: object | null = start; current !== null && !SHARED_ROOTS.has(current); current = Object.getPrototypeOf(current) as object | null) {
        const member: unknown = Object.getOwnPropertyDescriptor(current, key)?.[part];

        if (typeof member === "function") {
            found = member as () => unknown;
        }
    }

    return found;
};

const getter = (proto: object, key: string): (() => unknown) => deepest(proto, key, "get") as () => unknown;

const dateGetTime = deepest(Date.prototype, "getTime", "value") as () => unknown;
const mapSize = getter(Map.prototype, "size");
const setSize = getter(Set.prototype, "size");
const bufferByteLength = getter(ArrayBuffer.prototype, "byteLength");
// `URL` is absent from some embedded runtimes; its brand is then simply never matched.
const urlHref = typeof URL === "function" ? getter(URL.prototype, "href") : undefined;
// The static is looked up the same way, on the constructor chain, so a subclass's own `isError` is never the test.
const nativeErrorCheck = deepest(Error, "isError", "value") as ((value: unknown) => boolean) | undefined;
const errorPrototype = Error.prototype;

// `Error.isError` tests the internal slot. Without it (older runtimes) the best available
// test is ancestry, taken from the prototype already read so the object is not asked again.
const isError = (value: object, proto: object | null): boolean =>
    typeof nativeErrorCheck === "function" ? nativeErrorCheck(value) : proto !== null && (proto === errorPrototype || errorPrototype.isPrototypeOf(proto));

const mapForEach = deepest(Map.prototype, "forEach", "value") as (callback: (value: unknown, key: unknown) => void) => void;
const setForEach = deepest(Set.prototype, "forEach", "value") as (callback: (value: unknown) => void) => void;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewGetters = {
    data: {
        buffer: getter(DataView.prototype, "buffer"),
        byteLength: getter(DataView.prototype, "byteLength"),
        byteOffset: getter(DataView.prototype, "byteOffset"),
    },
    typed: {
        buffer: getter(typedArrayPrototype, "buffer"),
        byteLength: getter(typedArrayPrototype, "byteLength"),
        byteOffset: getter(typedArrayPrototype, "byteOffset"),
    },
};

/*
 * Readers for a value {@link classifyNode} branded. The brand is the internal slot, so the contents come from the
 * slot too, through the same native functions: an `entries()`, iterator, `getTime` or `buffer` a subclass (or a
 * subclass from another realm) overrides could otherwise omit or invent what is encoded.
 */
export const nativeTime = (value: object): number => Reflect.apply(dateGetTime, value, []) as number;

export const nativeHref = (value: object): string => Reflect.apply(urlHref as () => unknown, value, []) as string;

export const nativeMapEntries = (value: object): [unknown, unknown][] => {
    const entries: [unknown, unknown][] = [];

    Reflect.apply(mapForEach, value, [(entry: unknown, key: unknown) => entries.push([key, entry])]);

    return entries;
};

export const nativeSetValues = (value: object): unknown[] => {
    const values: unknown[] = [];

    Reflect.apply(setForEach, value, [(entry: unknown) => values.push(entry)]);

    return values;
};

/** The bytes a view covers, through the native getters for its kind (a `DataView` has its own). */
export const nativeViewBytes = (view: object): Uint8Array => {
    const getters = brand(() => Reflect.apply(viewGetters.typed.buffer, view, [])) ? viewGetters.typed : viewGetters.data;

    return new Uint8Array(
        Reflect.apply(getters.buffer, view, []) as ArrayBuffer,
        Reflect.apply(getters.byteOffset, view, []) as number,
        Reflect.apply(getters.byteLength, view, []) as number,
    );
};

export const classifyNode = (value: object): NodeKind => {
    if (Array.isArray(value)) {
        return "array";
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto === null || proto === Object.prototype) {
        return "plain";
    }

    if (brand(() => Reflect.apply(dateGetTime, value, []))) {
        return "builtin-date";
    }

    if (urlHref !== undefined && brand(() => Reflect.apply(urlHref, value, []))) {
        return "builtin-url";
    }

    if (brand(() => Reflect.apply(mapSize, value, []))) {
        return "builtin-map";
    }

    if (brand(() => Reflect.apply(setSize, value, []))) {
        return "builtin-set";
    }

    if (brand(() => Reflect.apply(bufferByteLength, value, []))) {
        return "builtin-array-buffer";
    }

    if (ArrayBuffer.isView(value)) {
        return "builtin-view";
    }

    // Last on purpose: every brand above is an internal slot no object can fake, while the Error test may fall back
    // to a shim or to ancestry. Testing it first would let a permissive `isError` claim a real Map or Date.
    return isError(value, proto) ? "builtin-error" : "other";
};
