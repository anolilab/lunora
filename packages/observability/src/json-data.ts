/** Deeper than this, {@link isSmallJsonData} gives up and the value is simply not memoised. */
const JSON_DATA_MAX_DEPTH = 32;

/**
 * True when `value` is small and nothing but JSON data — `null`, booleans,
 * strings, finite numbers, and arrays / plain objects of them — so its
 * `JSON.stringify` names it exactly. Anything else (an `undefined` property, a
 * `Date`, a `Map`, a class instance, a hole) is either dropped or flattened by
 * `JSON.stringify` while the redactor sees it, so two different values could
 * share one text.
 *
 * "Small" is a running budget of `maxChars`, charged
 * one per value plus the length of every string and key, so the walk stops early
 * on a large payload and the caller never stringifies one just to key a memo.
 */
const isSmallJsonData = (value: unknown, maxChars: number): boolean => {
    let budget = maxChars;

    // Assigned below: `visitField` and `visitContainer` recurse into it.
    let visit: (node: unknown, depth: number) => boolean;

    // Read through the descriptor: a getter would run again in the redactor and in
    // `JSON.stringify`, free to answer differently each time.
    const visitField = (node: object, key: number | string, depth: number): boolean => {
        const descriptor = Object.getOwnPropertyDescriptor(node, key);

        return descriptor !== undefined && "value" in descriptor && visit(descriptor.value, depth + 1);
    };

    const visitContainer = (node: object, depth: number): boolean => {
        if (Array.isArray(node)) {
            for (let index = 0; index < node.length; index += 1) {
                if (!visitField(node, index, depth)) {
                    return false;
                }
            }

            return true;
        }

        const proto = Object.getPrototypeOf(node) as object | null;

        if (proto !== null && proto !== Object.prototype) {
            return false;
        }

        // `Object.keys`, not `Object.entries`: no field is read before the walk reaches
        // it, so a large object stops at the budget without running later getters.
        for (const key of Object.keys(node)) {
            budget -= key.length;

            if (budget < 0 || !visitField(node, key, depth)) {
                return false;
            }
        }

        return true;
    };

    visit = (node: unknown, depth: number): boolean => {
        budget -= 1;

        if (budget < 0) {
            return false;
        }

        if (node === null || typeof node === "boolean") {
            return true;
        }

        if (typeof node === "string") {
            budget -= node.length;

            return budget >= 0;
        }

        if (typeof node === "number") {
            return Number.isFinite(node);
        }

        // `JSON.stringify` calls a `toJSON` (own, non-enumerable or inherited) that the
        // redactor never sees, so the text would not name what gets redacted. `in`, not
        // a read, so a `toJSON` getter does not run.
        if (typeof node !== "object" || depth >= JSON_DATA_MAX_DEPTH || "toJSON" in node) {
            return false;
        }

        return visitContainer(node, depth);
    };

    return visit(value, 0);
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { isSmallJsonData };
