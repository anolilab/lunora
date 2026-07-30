/**
 * Row-identity and chip-value formatting for the `.global()` browser.
 *
 * Its own module because the browser and its extracted page surface both need
 * them, and neither touches React — so they are unit-testable directly.
 */

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index.toString()}`;
};

/** Render a facet/filter value for a removable chip, distinguishing NULL and the empty string from a real value. */
const chipValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "∅";
    }

    if (value === "") {
        return "(empty)";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-object primitives stringify meaningfully; objects are handled above.
    return String(value);
};

export { chipValue, rowKey };
