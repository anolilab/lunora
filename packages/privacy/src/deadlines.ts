/**
 * Calendar-month arithmetic for the GDPR Art. 12(3) response deadline.
 *
 * Reg. (EEC, Euratom) No 1182/71 Art. 3(2)(c) counts a month to the same date in
 * the next month, or to the last day of that month when the date does not exist
 * (31 January plus one month is 28 or 29 February). All arithmetic is UTC, so the
 * result does not depend on the host's timezone.
 */

/** One day in milliseconds. Every day-based period in the package is written in terms of it. */
export const DAY_MS: number = 24 * 60 * 60 * 1000;

/** Add whole calendar months to `date`, keeping the UTC time of day. */
export const addCalendarMonths = (date: Date, months: number): Date => {
    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth() + months;
    const firstOfTarget = new Date(Date.UTC(year, monthIndex, 1));
    const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();

    firstOfTarget.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    firstOfTarget.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());

    return firstOfTarget;
};

/** The response periods a request runs under, from the presets' `responseMonths` and `extensionMonths`. */
export interface DeadlinePolicy {
    /** Art. 12(3) sentence 2: further months when the controller extends the response. */
    readonly extensionMonths: number;
    /** Art. 12(3): months from receipt to the response. */
    readonly responseMonths: number;
}

/** The GDPR periods: one month to respond, and two further months on an extension. */
export const DEFAULT_DEADLINES: DeadlinePolicy = { extensionMonths: 2, responseMonths: 1 };

/**
 * The Art. 12(3) deadline for a request received at `receivedAt`: one calendar
 * month by default. The clock starts at receipt, not at verification of identity;
 * the package does not pause it by default (decision D6, legal review open).
 */
export const dueAt = (receivedAt: Date, policy: DeadlinePolicy = DEFAULT_DEADLINES): Date => addCalendarMonths(receivedAt, policy.responseMonths);

/**
 * The extended deadline under Art. 12(3) sentence 2: the further months counted
 * from receipt, so three months in total by default. It is counted from receipt
 * rather than from `dueAt`, because month arithmetic does not add up at month ends.
 */
export const extendedDueAt = (receivedAt: Date, policy: DeadlinePolicy = DEFAULT_DEADLINES): Date =>
    addCalendarMonths(receivedAt, policy.responseMonths + policy.extensionMonths);
