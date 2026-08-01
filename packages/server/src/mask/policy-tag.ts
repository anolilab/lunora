/**
 * Tag the `mask()` middleware with the per-table masked-column NAMES it
 * carries so the procedure builder can surface them on the registered
 * function (`fn.maskedTables`) without re-running the chain, and so a
 * project-wide registry can be built from every registered function's tags.
 *
 * Mirrors `../rls/policy-tag.ts` one-for-one — see that file's docblock for
 * the shared rationale (a non-enumerable, `Symbol.for`-keyed property so it
 * never leaks into a spread/serialization of the middleware, and two
 * independently-bundled copies of `@lunora/server` still agree on the key).
 *
 * Unlike RLS's tag (which carries live `when` policy closures), a mask tag
 * carries ONLY column NAMES — never the masking strategies/closures. A reader
 * of the tag (the registry below, or a future consumer) can only ever ask "is
 * column X of table Y masked", never what the mask does to it or for whom —
 * the same narrow surface `MaskColumnMetadataIR` exposes to the codegen
 * studio preview.
 *
 * `buildMaskRegistry` (below) is the project-wide counterpart of
 * `fn.maskedTables`: it unions every registered function's tagged columns per
 * table into one registry. It exists for parity with RLS's runtime registry
 * (`buildRlsReadRegistry`) and to carry Phase 2 (masking replicated shape
 * rows — not yet built). Phase 1's fail-closed shape/mask collision check
 * does NOT read this registry at runtime: it runs at `@lunora/codegen` build
 * time instead (`packages/codegen/src/run-codegen.ts`'s
 * `assertNoMaskedShapeTable`), because `mask(policies)` calls are almost
 * always a statically-readable object literal — the same static evidence
 * codegen already parses for the `mask_uncovered_pii_column` advisor lint and
 * the studio mask preview (`discoverMaskMetadata`) — so the collision can be
 * rejected before a single Durable Object ships, with no new registry
 * threaded into the generated `resolveShape` override or its wire protocol.
 */

/** Per-table masked column NAMES a single `.use(mask(...))` step carries — never the strategies. */
interface MaskTag {
    readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Project-wide masked-column registry: every table any registered function masks, unioned. */
type MaskRegistry = ReadonlyMap<string, ReadonlySet<string>>;

const MASK_TAG = Symbol.for("lunora.mask.middleware-columns");

/** Attach a {@link MaskTag} to a middleware function. Returns the same reference. */
const tagMaskMiddleware = <M extends object>(middleware: M, tag: MaskTag): M => {
    Object.defineProperty(middleware, MASK_TAG, { configurable: true, enumerable: false, value: tag });

    return middleware;
};

/** Read the {@link MaskTag} a middleware carries, or `undefined` for a non-mask middleware. */
const readMaskTag = (middleware: unknown): MaskTag | undefined => {
    if (middleware === null || (typeof middleware !== "function" && typeof middleware !== "object")) {
        return undefined;
    }

    return (middleware as Record<PropertyKey, unknown>)[MASK_TAG] as MaskTag | undefined;
};

/** A registered function that may carry the `.use(mask(...))` columns hoisted by the builder (`fn.maskedTables`). */
interface FunctionWithMaskedTables {
    readonly maskedTables?: ReadonlyMap<string, ReadonlySet<string>>;
}

/* eslint-disable no-secrets/no-secrets -- JSDoc names a code reference (`Object.values(LUNORA_FUNCTIONS)`), not a secret */

/**
 * Build the project-wide masked-column registry from the registered functions
 * (pass `Object.values(LUNORA_FUNCTIONS)`) — the mask-column twin of
 * `buildRlsReadRegistry`. Unions every function's `.use(mask(...))` columns
 * per table: a column masked by ANY registered function counts as masked in
 * the registry — there is no "which procedure would this shape have gone
 * through" question to narrow by, so the union is the only safe answer.
 */
/* eslint-enable no-secrets/no-secrets */
const buildMaskRegistry = (functions: Iterable<unknown>): MaskRegistry => {
    const registry = new Map<string, Set<string>>();

    for (const entry of functions) {
        const maskedTables = (entry as FunctionWithMaskedTables | null)?.maskedTables;

        if (!maskedTables) {
            continue;
        }

        for (const [table, columns] of maskedTables) {
            const set = registry.get(table) ?? new Set<string>();

            for (const column of columns) {
                set.add(column);
            }

            registry.set(table, set);
        }
    }

    return registry;
};

export type { MaskRegistry, MaskTag };
export { buildMaskRegistry, readMaskTag, tagMaskMiddleware };
