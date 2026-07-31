/**
 * The opaque `api` / `internal` proxy codegen emits into `_generated/api.ts`.
 *
 * Reading `api.<namespace>.<fn>` yields `{ __lunoraRef: "namespace:fn" }` — the
 * reference every dispatch path (`ctx.run*`, the client, the scheduler) resolves
 * a function by. The runtime value carries no type information; the generated
 * declarations supply that.
 *
 * Lives here rather than in `@lunora/server` because the generated `api.ts` is
 * the file a SIBLING package imports (a web app, another Worker), and its only
 * runtime import should be one that package already depends on. Emitting the
 * server-package specifier meant a browser app consuming `@acme/backend/api` had
 * to resolve `@lunora/server` — the server runtime — for a forty-line proxy.
 * Both `@lunora/server` and `@lunora/client` re-export it from here, so neither
 * package gains a dependency on the other and the public surface is unchanged.
 *
 * Both levels are memoised so repeated reads of the same reference are
 * identity-stable — call sites compare and cache these.
 */
const namespaceCache = new Map<PropertyKey, Record<string, unknown>>();

const anyApi: Record<string, Record<string, unknown>> = new Proxy(
    {},
    {
        get(_target, namespace: PropertyKey) {
            const cached = namespaceCache.get(namespace);

            if (cached) {
                return cached;
            }

            const referenceCache = new Map<PropertyKey, { __lunoraRef: string }>();
            const namespaceProxy = new Proxy(
                {},
                {
                    get(_inner, functionName: PropertyKey) {
                        const cachedReference = referenceCache.get(functionName);

                        if (cachedReference) {
                            return cachedReference;
                        }

                        const reference = { __lunoraRef: `${String(namespace)}:${String(functionName)}` };

                        referenceCache.set(functionName, reference);

                        return reference;
                    },
                },
            );

            namespaceCache.set(namespace, namespaceProxy);

            return namespaceProxy;
        },
    },
) as Record<string, Record<string, unknown>>;

export { anyApi };
