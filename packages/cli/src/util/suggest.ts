/**
 * "Did you mean …?" suggestions for mistyped command / subcommand names, via
 * Levenshtein edit distance. Kept pure and dependency-free so it's trivial to
 * unit-test and reuse anywhere a command takes a constrained name.
 */

/** Levenshtein edit distance between two strings (classic DP, single rolling row). */
const editDistance = (a: string, b: string): number => {
    const distances = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let row = 1; row <= a.length; row += 1) {
        let previousDiagonal = distances[0] ?? 0;

        distances[0] = row;

        for (let column = 1; column <= b.length; column += 1) {
            const previousColumn = distances[column] ?? 0;
            const cost = a[row - 1] === b[column - 1] ? 0 : 1;

            distances[column] = Math.min(
                (distances[column - 1] ?? 0) + 1, // insertion
                previousColumn + 1, // deletion
                previousDiagonal + cost, // substitution
            );

            previousDiagonal = previousColumn;
        }
    }

    return distances[b.length] ?? 0;
};

/**
 * The closest candidate to `input`, or `undefined` when nothing is near enough.
 * The threshold scales with the input length (longer words tolerate more typos)
 * but is at least 2, so a one-letter slip always suggests.
 */
const closestMatch = (input: string, candidates: ReadonlyArray<string>): string | undefined => {
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        const distance = editDistance(input, candidate);

        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }

    const threshold = Math.max(2, Math.ceil(input.length / 3));

    return best !== undefined && bestDistance <= threshold ? best : undefined;
};

export { closestMatch, editDistance };
