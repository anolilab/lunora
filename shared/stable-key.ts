/**
 * Canonical stable-key encoder shared by the client SDK (`@lunora/client`), the
 * React adapter (`@lunora/react`), and the Durable Object runtime (`@lunora/do`).
 *
 * It is deliberately **not** a package. `@lunora/client` is a dependency-free
 * standalone browser SDK and `@lunora/do` is a leaf server runtime, so there is
 * no shared low-level package the three could import without coupling the
 * browser bundle to the server (or vice versa). Instead each consumer imports
 * this file by relative path and the bundler (packem/rollup) inlines it: no
 * runtime dependency edge is created, and the (tree-shaken) helper is duplicated
 * only in emitted output, never in source. One source of truth, zero deps.
 *
 * Semantics — a stable, sorted JSON encoding of `value` for use as a cache /
 * dedup / query key. Object keys are visited in code-point order at every depth
 * so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` encode identically. Arrays preserve
 * order (the index IS the key). `undefined` is skipped at the object level so
 * `{ a: undefined }` collides with `{}` — matching Convex behavior and avoiding
 * spurious cache misses on optional args — while inside an array it encodes as
 * `null` to preserve positional semantics.
 *
 * Fail-loud contract: a value a stable JSON key can't faithfully encode throws a
 * `TypeError` rather than silently collapsing to a colliding key. `bigint` (which
 * `JSON.stringify` rejects) and non-plain objects (`Date`, `ArrayBuffer`, typed
 * arrays, `Map`, `Set`, `RegExp`, class instances — all of which have no own
 * enumerable keys and would otherwise encode to `{}`) are refused, so two distinct
 * values can never share one cache key and serve each other's cached data. Keys
 * over values that may legitimately carry wire-typed leaves (subscription /
 * `useQuery` / shape args) should use {@link file://./wire-key.ts}'s
 * `stableWireKey` instead, which tokenizes exactly the types the wire supports
 * and stays byte-identical to this encoder for pure JSON.
 *
 * Non-finite numbers are tagged, not thrown: `JSON.stringify` maps `NaN`,
 * `Infinity`, and `-Infinity` all to the literal `"null"`, which would otherwise
 * collide with real `null` and with each other. Callers (the flags memo key, the
 * metric-series key) need a key even for these inputs, so each encodes as its own
 * bare, unquoted token — `nan` / `inf` / `-inf`, reusing {@link file://./wire-codec.ts}'s
 * `encodeWire` vocabulary for the same three cases — rather than throwing. A bare
 * token can never collide with `JSON.stringify` output: every JSON string is
 * quoted, and these tokens don't match `null`/`true`/`false`. `-0` is tagged the
 * same way, as `-0`, distinct from `0`'s `"0"`. `undefined` is the one collapse
 * that remains: at the top level and inside arrays it still encodes as `null`
 * (see below — deliberate, unrelated to this), and object fields set to
 * `undefined` are still skipped, not nulled.
 *
 * NOTE: `@lunora/seed`'s `copycat/hash.ts` carries its own, intentionally
 * forked, `stableStringify`. Do **not** fold it into this one: its hash domain
 * depends on an exact encoding (e.g. it must never emit `U+0000` at the start and
 * does not skip `undefined` fields). The two are different contracts.
 */

/**
 * Whether a string needs JSON escaping — a quote, a backslash, a control
 * character, or any surrogate code unit.
 *
 * Surrogates are excluded from the fast path wholesale, pairs included, even
 * though a well-formed pair passes through `JSON.stringify` unchanged. Only a
 * LONE surrogate is escaped (to `\udXXX`), and telling the two apart costs more
 * than handing the whole string to `JSON.stringify`. Emoji keys therefore take
 * the slow path, which is correct and rare.
 */
const NEEDS_ESCAPE = /["\\\u0000-\u001F\uD800-\uDFFF]/;

/**
 * `JSON.stringify` for a string, skipped when nothing in it can escape.
 *
 * Keys and short string leaves dominate these encodings and almost never need
 * escaping, and wrapping in quotes directly measured ~1.2x over the generic
 * call on realistic query args.
 */
const quote = (text: string): string => (NEEDS_ESCAPE.test(text) ? JSON.stringify(text) : `"${text}"`);

const stableStringify = (value: unknown): string => {
    // Encode `undefined` as `null` (mirrors `JSON.stringify`'s array-element
    // behavior) so an `undefined` value never collapses an array position. This
    // branch fires at the top level too; object *fields* set to `undefined` are
    // handled separately below (skipped, not nulled).
    if (value === undefined) {
        return "null";
    }

    // Fail loud on a `bigint`: `JSON.stringify(1n)` throws a cryptic native error,
    // so surface a clear, actionable one instead. A bigint isn't supported in a
    // stable JSON key — pass it as a string, or key on the wire form (`stableWireKey`).
    if (typeof value === "bigint") {
        throw new TypeError("stableStringify: cannot use a bigint in a stable JSON cache key — pass it as a string, or use stableWireKey");
    }

    // Tag non-finite numbers (and `-0`) as distinct, unquoted tokens instead of
    // letting the generic `JSON.stringify` fallback below collapse `NaN`/
    // `Infinity`/`-Infinity` all into the literal string `"null"` — colliding with
    // real `null` and with each other. A bare unquoted token can never collide
    // with any `JSON.stringify` output: every JSON string is quoted, and none of
    // these tokens match `null`/`true`/`false`. Tokens match wire-codec.ts's
    // `encodeWire` vocabulary for the same three non-finite cases.
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return "nan";
        }

        if (value === Infinity) {
            return "inf";
        }

        if (value === -Infinity) {
            return "-inf";
        }

        if (Object.is(value, -0)) {
            return "-0";
        }
    }

    if (typeof value === "string") {
        return quote(value);
    }

    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        let out = "[";

        for (let index = 0; index < value.length; index++) {
            if (index > 0) {
                out += ",";
            }

            out += stableStringify(value[index]);
        }

        return out + "]";
    }

    // Reject non-plain objects (`Date`, `ArrayBuffer`, typed arrays, `Map`, `Set`,
    // `RegExp`, class instances). They have no own enumerable string keys, so the
    // record branch below would encode every one of them to `{}` — a SILENT
    // cache-key collision where two distinct values share a key and are served
    // each other's cached data. Fail loud at the call site instead. (Only plain
    // objects — `Object.prototype` or a null prototype — and arrays are keyable.)
    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto !== null && proto !== Object.prototype) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "value";

        throw new TypeError(
            `stableStringify: cannot use a ${name} in a stable JSON cache key — only plain objects, arrays, and JSON primitives are supported (wire-typed values key via stableWireKey)`,
        );
    }

    const record = value as Record<string, unknown>;
    // `sort()` with no comparator, not `toSorted(compareKeys)`. The default
    // comparator sorts strings by UTF-16 code unit — byte-identical to the
    // `a < b` comparator this replaces (verified by fuzzing both over random
    // key sets), and it is NOT locale-sensitive; that is `localeCompare`.
    // Sorting in place is safe because `Object.keys` hands back a fresh array.
    const keys = Object.keys(record).sort();
    let out = "{";
    let first = true;

    for (const key of keys) {
        const raw = record[key];

        if (raw === undefined) {
            continue;
        }

        if (first) {
            first = false;
        } else {
            out += ",";
        }

        out += quote(key);
        out += ":";
        out += stableStringify(raw);
    }

    return out + "}";
};

export { stableStringify };
