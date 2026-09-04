/**
 * Trim trailing slashes before joining a path onto a base URL.
 *
 * A loop rather than a `/\/+$/` replace: a greedy trailing quantifier over a
 * configured value is the classic catastrophic-backtracking shape, and several
 * callers sit on the request path.
 *
 * The dispatcher (`src/dispatcher/worker.ts`) keeps its own copy on purpose: it
 * is a separate bundle that imports nothing from the control plane.
 */
const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

export default stripTrailingSlashes;
