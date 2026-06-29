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

    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
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
