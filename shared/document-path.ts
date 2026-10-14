/**
 * Read a value out of a document by a dot-separated path.
 *
 * Schema options that name a column — `.searchIndex({ field })`,
 * `.vectorize(field, …)` — accept a path into a nested object
 * (`"properties.name"`), so the runtimes that read those fields have to resolve
 * one the same way. A missing or non-object segment yields `undefined`, which
 * each caller coerces to its own "nothing to index" value rather than throwing:
 * one unreadable document must never fail a write.
 *
 * Lives in `shared/` because `@lunora/do` (search) and `@lunora/bindings`
 * (vectors) both need it and neither should gain a dependency on the other; the
 * bundler inlines it into each `dist`.
 */
export const resolveDocumentPath = (document: Record<string, unknown>, field: string): unknown => {
    if (!field.includes(".")) {
        return document[field];
    }

    let current: unknown = document;

    for (const segment of field.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
};
