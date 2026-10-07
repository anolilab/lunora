/**
 * The opaque `api` / `internal` proxy codegen emits into `_generated/api.ts`.
 *
 * Reading `api.<…path>.<fn>` yields a reference whose `__lunoraRef` is
 * `"<path joined by _>:<fn>"` — `api.billing.invoices.create` is
 * `"billing_invoices:create"`, the dispatch key `lunora/billing/invoices.ts`
 * registers under. That is the reference every dispatch path (`ctx.run*`, the
 * client, the scheduler) resolves a function by. The runtime value carries no
 * type information; the generated declarations supply that.
 *
 * Every node from depth two down is both a reference and a namespace, because a
 * file (`lunora/billing.ts`) and a folder (`lunora/billing/`) can share a name.
 * The reference is the node's own `__lunoraRef` property, so spreading or
 * serialising a reference still yields `{ __lunoraRef }`. Codegen builds the same
 * key from source in `functionKeyOf` (`@lunora/codegen`); the two must agree.
 *
 * Lives here rather than in `@lunora/server` because the generated `api.ts` is
 * the file a SIBLING package imports (a web app, another Worker), and its only
 * runtime import should be one that package already depends on. Emitting the
 * server-package specifier meant a browser app consuming `@acme/backend/api` had
 * to resolve `@lunora/server` — the server runtime — for a forty-line proxy.
 * Both `@lunora/server` and `@lunora/client` re-export it from here, so neither
 * package gains a dependency on the other and the public surface is unchanged.
 *
 * Every level is memoised so repeated reads of the same reference are
 * identity-stable — call sites compare and cache these.
 */
const createNode = (segments: ReadonlyArray<string>): Record<string, unknown> => {
    const target: Record<string, unknown> = segments.length < 2 ? {} : { __lunoraRef: `${segments.slice(0, -1).join("_")}:${String(segments.at(-1))}` };
    const children = new Map<string, Record<string, unknown>>();

    return new Proxy(target, {
        get(_target, property: string | symbol) {
            // Names that start with `__` or `$` are never path segments: they are
            // how frameworks probe an object (Vue's `__v_raw`, React's `$$typeof`),
            // and a child proxy would answer every probe with another truthy
            // proxy, forever. Codegen rejects such names for functions and files.
            //
            // A reference node also keeps its inherited members (`toString`, …)
            // so it still behaves as a plain object. The root and first level are
            // never references, so every other name there is a path segment — a
            // function may be exported as `toString`. Codegen rejects that name
            // deeper down, where it would hit the inherited member.
            if (typeof property === "symbol" || property.startsWith("__") || property.startsWith("$") || (segments.length >= 2 && property in target)) {
                return Reflect.get(target, property) as unknown;
            }

            let child = children.get(property);

            if (child === undefined) {
                child = createNode([...segments, property]);
                children.set(property, child);
            }

            return child;
        },
    });
};

const anyApi = createNode([]) as Record<string, Record<string, unknown>>;

export { anyApi };
