/**
 * Spread-friendly single-key override for an OPTIONAL writer method.
 * `rankBefore` and `rankPageRows` are both optional on the real writer type —
 * only the shard-local `@lunora/shard-engine` writer implements them, the
 * D1/sql-store twin omits both — so `../rls/middleware` and `../mask/middleware`
 * each need to add their override to the wrapped writer ONLY when the
 * underlying `base` actually carries the method, exactly mirroring the
 * `...base` spread's own pass-through for a writer that doesn't. Every one of
 * those four call sites (two methods × two middlewares) used to hand-write the
 * same `...(base ? { [key]: … } : {})` shape; this collapses it to one call so
 * the four can't drift out of sync with each other.
 * @param key the property name to install on the returned object
 * @param base the underlying method, or `undefined` when the writer omits it
 * @param build builds the override from the underlying method; only invoked when `base` is defined
 * @returns `{ [key]: build(base) }` when `base` is defined, otherwise `{}` (so the spread adds nothing)
 */
const optionalWriterOverride = <F>(key: string, base: F | undefined, build: (base: F) => unknown): Record<string, unknown> =>
    base ? { [key]: build(base) } : {};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through the module uniform (same rationale as `estimate-bytes.ts`/`serialize-sql.ts`).
export { optionalWriterOverride };
