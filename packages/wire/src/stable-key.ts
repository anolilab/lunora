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
 * dedup / query key. Object keys are visited in UTF-16 **code-unit** order at
 * every depth so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` encode identically —
 * `Array.prototype.sort`'s default comparator, which is what every JS engine
 * gives you. NOT code-point order: the two differ for any key starting with a
 * surrogate, so an emoji key sorts BEFORE a U+E000..U+FFFF key here and after it
 * under code point. A port must sort by UTF-16 code unit (Python `sorted` on the
 * raw `str`, Go `sort.Strings`, and Rust `str` `Ord` all compare code points and
 * are therefore WRONG); `protocol/fixtures/stable-wire-key.json`'s
 * `key-order-surrogate-vs-pua` case is the one that separates them. Arrays preserve
 * order (the index IS the key). `undefined` is skipped at the object level so
 * `{ a: undefined }` collides with `{}` — matching Convex behavior and avoiding
 * spurious cache misses on optional args — while inside an array it encodes as
 * `null` to preserve positional semantics.
 *
 * Fail-loud contract: a value a stable JSON key can't faithfully encode throws a
 * `TypeError` rather than silently collapsing to a colliding key. `bigint` (which
 * `JSON.stringify` rejects), functions and symbols (which it maps to `undefined`), and non-plain objects (`Date`, `ArrayBuffer`, typed
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
// eslint-disable-next-line no-control-regex -- the control range U+0000-U+001F is exactly what JSON requires escaping
const NEEDS_ESCAPE = /["\\\u0000-\u001F\uD800-\uDFFF]/;

/**
 * `JSON.stringify` for a string, skipped when nothing in it can escape.
 *
 * Keys and short string leaves dominate these encodings and almost never need
 * escaping, and wrapping in quotes directly measured ~1.2x over the generic
 * call on realistic query args.
 */
const quote = (text: string): string => (NEEDS_ESCAPE.test(text) ? JSON.stringify(text) : `"${text}"`);

/** The bare token for a non-finite number or `-0`, or `undefined` for any other number. */
const numberToken = (value: number): string | undefined => {
    if (Number.isNaN(value)) {
        return "nan";
    }

    if (value === Infinity) {
        return "inf";
    }

    if (value === -Infinity) {
        return "-inf";
    }

    return Object.is(value, -0) ? "-0" : undefined;
};

/** Encode an object that is not an array: plain objects only, sorted by UTF-16 code unit. */
const stringifyRecord = (value: object, encode: (item: unknown) => string): string => {
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
    // No comparator, not `toSorted(compareKeys)`. The default comparator sorts
    // strings by UTF-16 code unit — byte-identical to the `a < b` comparator it
    // replaces (verified by fuzzing both over random key sets), and it is NOT
    // locale-sensitive; that is `localeCompare`. Code-unit order is the cross-language
    // contract, so the lint's `localeCompare` suggestion would be wrong.
    // `sort`, not `toSorted`: `Object.keys` already returns a fresh array and the client bundle must
    // not require `Array.prototype.toSorted`.
    // eslint-disable-next-line sonarjs/no-alphabetical-sort, unicorn/no-array-sort -- code-unit order (the default comparator) is the key-order contract, and `toSorted` is not available in every client runtime
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
        out += encode(raw);
    }

    return `${out}}`;
};

const stableStringify = (value: unknown): string => {
    // Encode `undefined` as `null` (mirrors `JSON.stringify`'s array-element
    // behavior) so an `undefined` value never collapses an array position. This
    // branch fires at the top level too; object *fields* set to `undefined` are
    // handled separately (skipped, not nulled).
    if (value === undefined) {
        return "null";
    }

    // Fail loud on a `bigint`: `JSON.stringify(1n)` throws a cryptic native error,
    // so surface a clear, actionable one instead. A bigint isn't supported in a
    // stable JSON key — pass it as a string, or key on the wire form (`stableWireKey`).
    if (typeof value === "bigint") {
        throw new TypeError("stableStringify: cannot use a bigint in a stable JSON cache key — pass it as a string, or use stableWireKey");
    }

    // Fail loud on a function or symbol too: `JSON.stringify` returns `undefined` for
    // both (not a string), so a key built from one would be the text "undefined"
    // inside an object and collide with every other such value.
    if (typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(
            `stableStringify: cannot use a ${typeof value} in a stable JSON cache key — only plain objects, arrays, and JSON primitives are supported`,
        );
    }

    // Tag non-finite numbers (and `-0`) as distinct, unquoted tokens instead of
    // letting the generic `JSON.stringify` fallback below collapse `NaN`/
    // `Infinity`/`-Infinity` all into the literal string `"null"` — colliding with
    // real `null` and with each other. A bare unquoted token can never collide
    // with any `JSON.stringify` output: every JSON string is quoted, and none of
    // these tokens match `null`/`true`/`false`. Tokens match wire-codec.ts's
    // `encodeWire` vocabulary for the same three non-finite cases.
    if (typeof value === "number") {
        const token = numberToken(value);

        if (token !== undefined) {
            return token;
        }
    }

    if (typeof value === "string") {
        return quote(value);
    }

    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        // Every index is read, holes included (they encode as `null` like `undefined`), and never
        // through the array's own iterator or `map`: a custom `Symbol.iterator` must not change the
        // key, and `map` would skip holes and make `[, 1]` collide with other shapes.
        const items = Array.from({ length: value.length }, (_, index) => stableStringify((value as unknown[])[index]));

        return `[${items.join(",")}]`;
    }

    return stringifyRecord(value, stableStringify);
};

export default stableStringify;
