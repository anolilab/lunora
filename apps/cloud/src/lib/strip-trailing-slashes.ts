/**
 * Trim trailing slashes before joining a path onto a base URL.
 *
 * A loop rather than a `/\/+$/` replace: a greedy trailing quantifier over a
 * configured value is the classic catastrophic-backtracking shape, and several
 * callers sit on the request path.
 *
 * Shared because there were five identical copies inside this one bundle. They
 * were all correct, which is exactly why it is worth consolidating now — the same
 * habit produced two copies of the Analytics Engine `quote` helper, and there one
 * of them had silently missed a hardening pass.
 *
 * The dispatcher (`src/dispatcher/worker.ts`) deliberately keeps its own copy and
 * says so: it is a separate bundle that imports nothing from the control plane.
 * Leave that one alone.
 */
const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

export default stripTrailingSlashes;
