/**
 * Fractional index keys.
 *
 * A card's position is a short string, not an integer. Reordering one card
 * writes exactly one row — the key strictly between its new neighbours — so two
 * people dragging different cards never touch the same rows and never conflict
 * under the shard's OCC. Integer positions would have to renumber the tail on
 * every drop, which is both a bigger write set and a guaranteed conflict.
 *
 * Keys are base-26 (`a`–`z`) fractions with an implied leading `0.`, so plain
 * lexicographic comparison is positional comparison. `a` is the zero digit and
 * a key therefore never ends in `a` — a trailing zero has no midpoint below it.
 */
const DIGITS = "abcdefghijklmnopqrstuvwxyz";
const ZERO = "a";

/**
 * The key strictly between `before` and `after`, either of which may be `null`
 * for "nothing on that side". Throws when the inputs are not ordered — that
 * means the caller read a stale list, and silently emitting a colliding key
 * would corrupt the board rather than fail loudly.
 */
export const midpoint = (before: string | null, after: string | null): string => {
    const a = before ?? "";
    const b = after;

    if (b !== null && a >= b) {
        throw new Error(`midpoint: keys out of order (${a} >= ${b})`);
    }

    if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) {
        throw new Error(`midpoint: key ends in the zero digit (${a}, ${String(b)})`);
    }

    if (b !== null) {
        // Skip the shared prefix and recurse on the remainder: the midpoint of
        // "cb" and "cd" is "c" + midpoint("b", "d").
        let shared = 0;

        while ((a[shared] ?? ZERO) === b[shared]) {
            shared += 1;
        }

        if (shared > 0) {
            return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
        }
    }

    const digitA = a === "" ? 0 : DIGITS.indexOf(a[0] as string);
    const digitB = b === null ? DIGITS.length : DIGITS.indexOf(b[0] as string);

    if (digitB - digitA > 1) {
        return DIGITS[Math.round((digitA + digitB) / 2)] as string;
    }

    // The leading digits are adjacent, so there is no room at this position.
    // Either borrow a digit from `after`, or lengthen `before`.
    if (b !== null && b.length > 1) {
        return b.slice(0, 1);
    }

    return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
};
