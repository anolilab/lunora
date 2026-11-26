/**
 * Storage codec for better-auth's `date` fields.
 *
 * `authTables` declares every such column `v.date()`, an epoch-millisecond number, and
 * Lunora's writer re-validates the whole row on `ctx.db.patch`. The adapter therefore has
 * to store numbers: an ISO string written here makes the next Lunora patch of any other
 * column on that row fail validation.
 */

/** An epoch-ms number already stored in a TEXT-affinity column reads back as its digits, signed before 1970. */
const EPOCH_DIGITS = /^-?\d+(?:\.\d+)?$/u;

/**
 * Epoch ms for a value better-auth hands the adapter for a `date` field: a `Date` on writes,
 * and on where clauses whatever the caller passed (a `Date`, or an already-serialised string
 * or number). Anything unparseable passes through unchanged, so SQL sees what was given.
 */
const encodeAuthDate = (value: unknown): unknown => {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === "string") {
        const millis = EPOCH_DIGITS.test(value) ? Number(value) : Date.parse(value);

        return Number.isNaN(millis) ? value : millis;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => encodeAuthDate(entry));
    }

    return value;
};

/**
 * A stored `date` cell as the `Date` better-auth expects. Accepts the epoch-ms numbers this
 * adapter writes and the ISO strings earlier versions wrote, so rows that predate the
 * conversion keep reading correctly.
 */
const decodeAuthDate = (value: unknown): unknown => {
    if (typeof value === "number") {
        return new Date(value);
    }

    if (typeof value === "string") {
        return new Date(EPOCH_DIGITS.test(value) ? Number(value) : value);
    }

    return value;
};

export { decodeAuthDate, encodeAuthDate };
