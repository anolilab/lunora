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
 * answer for any object (a Map would then pass as a URL or a Date), so it is never the brand.
 */
const deepest = (start: object, key: string, part: "get" | "value"): (() => unknown) | undefined => {
    let found: (() => unknown) | undefined;

    for (let current: object | null = start; current !== null; current = Object.getPrototypeOf(current) as object | null) {
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

    if (isError(value, proto)) {
        return "builtin-error";
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

    return ArrayBuffer.isView(value) ? "builtin-view" : "other";
};
