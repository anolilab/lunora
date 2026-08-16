/**
 * Evaluate a Vectorize-shaped metadata filter locally.
 *
 * The vector leg hands its filter to Vectorize, which evaluates it remotely. A
 * lexical store has no such service, so to honour the *same* predicate — which
 * it must, or hybrid retrieval would surface rows the RLS filter excludes — it
 * has to evaluate the expression itself. This is that evaluator.
 *
 * Supports the subset Vectorize documents: implicit equality
 * (`{ status: "published" }`), the comparison operators `$eq` / `$ne` / `$lt` /
 * `$lte` / `$gt` / `$gte`, set membership `$in` / `$nin`, and dot-notation
 * paths into nested objects (`{ "author.id": 7 }`).
 *
 * **Unknown operators fail closed.** A filter this evaluator does not
 * understand must exclude the row rather than admit it: the filters that matter
 * are tenant and RBAC scopes, and the failure mode of guessing wrong is a
 * cross-tenant leak, not a missing result.
 * @experimental
 */

/** Operators recognised inside an operator object. */
const OPERATORS = new Set(["$eq", "$gt", "$gte", "$in", "$lt", "$lte", "$ne", "$nin"]);

/**
 * Read a dot-notation path out of a metadata object.
 *
 * Own-property checks throughout: a path like `constructor.name` must resolve
 * to nothing rather than walk the prototype chain into a value the caller never
 * stored.
 */
const valueAtPath = (metadata: Record<string, unknown>, path: string): unknown => {
    if (Object.hasOwn(metadata, path)) {
        return metadata[path];
    }

    let current: unknown = metadata;

    for (const segment of path.split(".")) {
        if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
};

/** Loose equality over the JSON-ish scalars metadata holds. */
const scalarEquals = (left: unknown, right: unknown): boolean => left === right;

/** Ordered comparison, defined only for two numbers or two strings. */
const compare = (left: unknown, right: unknown): number | undefined => {
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }

    if (typeof left === "string" && typeof right === "string") {
        return left.localeCompare(right);
    }

    return undefined;
};

/** Evaluate one `{ $op: operand }` clause against a stored value. */
const matchesOperator = (operator: string, operand: unknown, value: unknown): boolean => {
    switch (operator) {
        case "$eq": {
            return scalarEquals(value, operand);
        }

        case "$in": {
            return Array.isArray(operand) && operand.some((entry) => scalarEquals(value, entry));
        }

        case "$ne": {
            return !scalarEquals(value, operand);
        }

        case "$nin": {
            return Array.isArray(operand) && !operand.some((entry) => scalarEquals(value, entry));
        }

        default: {
            const delta = compare(value, operand);

            // Incomparable operands (a missing field, mismatched types) exclude
            // the row: a range predicate over a value that has no order cannot
            // be said to hold.
            if (delta === undefined) {
                return false;
            }

            if (operator === "$lt") {
                return delta < 0;
            }

            if (operator === "$lte") {
                return delta <= 0;
            }

            if (operator === "$gt") {
                return delta > 0;
            }

            return delta >= 0;
        }
    }
};

/** True when `clause` is an operator object (`{ $gte: 3 }`) rather than a literal. */
const isOperatorClause = (clause: unknown): clause is Record<string, unknown> =>
    typeof clause === "object" && clause !== null && !Array.isArray(clause) && Object.keys(clause).some((key) => key.startsWith("$"));

/**
 * True when `metadata` satisfies every clause of `filter`. An empty or absent
 * filter matches everything; absent metadata satisfies only an empty filter.
 *
 * Clauses are ANDed, matching Vectorize.
 */
const matchesMetadataFilter = (metadata: Record<string, unknown> | undefined, filter: Record<string, unknown> | undefined): boolean => {
    if (filter === undefined || Object.keys(filter).length === 0) {
        return true;
    }

    if (metadata === undefined) {
        return false;
    }

    for (const [path, clause] of Object.entries(filter)) {
        const value = valueAtPath(metadata, path);

        if (!isOperatorClause(clause)) {
            if (!scalarEquals(value, clause)) {
                return false;
            }

            continue;
        }

        for (const [operator, operand] of Object.entries(clause)) {
            // Fail closed on anything unrecognised — see the module note.
            if (!OPERATORS.has(operator) || !matchesOperator(operator, operand, value)) {
                return false;
            }
        }
    }

    return true;
};

export default matchesMetadataFilter;
