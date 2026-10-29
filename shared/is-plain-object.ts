/**
 * The wire codec's definition of a plain object: an `Object.prototype` or
 * null-prototype object. Arrays fail it (their prototype is `Array.prototype`),
 * as do `Date`, `Map`, `Set`, `ArrayBuffer` and every typed-array view.
 *
 * Exported because it is the boundary between "a document" and "a value that
 * merely decoded to an object". Callers that parse a stored/received blob need
 * exactly this test, and testing for `!Array.isArray` instead is a trap: it is
 * sufficient for a bare `JSON.parse` (whose only non-plain root is an array) but
 * NOT after `decodeWire`, which turns a root-level tagged array into a
 * `Uint8Array`/`Date`/`Map` that passes an array-only check.
 *
 * Bundler-inlined; `@lunora/wire` re-exports it so server packages get the same function.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    return proto === null || proto === Object.prototype;
};
