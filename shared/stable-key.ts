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
 * NOTE: `@lunora/seed`'s `copycat/hash.ts` carries its own, intentionally
 * forked, `stableStringify`. Do **not** fold it into this one: its hash domain
 * depends on an exact encoding (e.g. it must never emit `U+0000` at the start and
 * does not skip `undefined` fields). The two are different contracts.
 */

/** Code-point-stable key comparator (no locale dependence) for deterministic encoding. */
const compareKeys = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

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

    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
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
    const keys = Object.keys(record).toSorted(compareKeys);
    const parts: string[] = [];

    for (const key of keys) {
        const raw = record[key];

        if (raw === undefined) {
            continue;
        }

        parts.push(`${JSON.stringify(key)}:${stableStringify(raw)}`);
    }

    return `{${parts.join(",")}}`;
};

export { stableStringify };
