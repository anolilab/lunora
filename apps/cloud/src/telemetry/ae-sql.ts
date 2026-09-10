/** Shared primitives for building Analytics Engine SQL, used by every AE reader. */

/**
 * Escape a string for a single-quoted SQL literal.
 *
 * The AE SQL API takes raw text — there are no bound parameters — so this is the
 * entire defence against injection on every read that interpolates a value.
 *
 * Backslash FIRST, then the quote. The AE SQL API is ClickHouse, which honours
 * backslash escapes inside string literals, so doubling the quote alone leaves a
 * value ending in a backslash able to escape its own closing quote. Whether that
 * is currently reachable depends on whether another predicate follows the
 * interpolated one — an accident of clause order, not a property, and the next
 * appended `AND` turns it into a live injection.
 */
export const quote = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/**
 * The separator for composite accumulator keys folded out of AE rows.
 *
 * A NUL escape rather than a printable character: the parts are user-supplied
 * metric names and function paths, so any printable separator can also appear
 * INSIDE a part and collide two distinct series into one. Space-joined, a metric
 * named `"checkout latency"` with an empty kind and one named `"checkout"` with
 * kind `"latency"` produce the same key and silently sum together.
 *
 * Written as the escape sequence, never as a literal control byte — a raw NUL in
 * a source file makes the whole file binary to `grep`, which silently voids every
 * text search that would otherwise have found it.
 */
export const KEY_SEPARATOR = "\u0000";
