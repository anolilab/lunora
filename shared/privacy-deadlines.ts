/**
 * The GDPR Art. 12(3) response deadline, and when a request is overdue.
 *
 * `@lunora/privacy` judges a request overdue in its deadline sweep, and the Studio's
 * Privacy requests page flags the same requests. Both compute the deadline from the
 * receipt date with these functions, so a stored deadline that drifted cannot make
 * the two disagree. The Studio must not depend on the runtime package, so the rule
 * lives here and the bundler inlines it into each.
 *
 * Reg. (EEC, Euratom) No 1182/71 Art. 3(2)(c) counts a month to the same date in the
 * next month, or to the last day of that month when the date does not exist (31 January
 * plus one month is 28 or 29 February). All arithmetic is UTC, so the result does not
 * depend on the host's timezone.
 */
import type { RequestStatus } from "./privacy-request-status";
import { isTerminal } from "./privacy-request-status";

/** Add whole calendar months to `date`, keeping the UTC time of day. */
const addCalendarMonths = (date: Date, months: number): Date => {
    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth() + months;
    const firstOfTarget = new Date(Date.UTC(year, monthIndex, 1));
    const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();

    firstOfTarget.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    firstOfTarget.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());

    return firstOfTarget;
};

/** The deadline for a request received at `receivedAt`: one calendar month. */
const dueAt = (receivedAt: Date): Date => addCalendarMonths(receivedAt, 1);

/** The extended deadline under Art. 12(3) sentence 2: two further months, so three months from receipt. */
const extendedDueAt = (receivedAt: Date): Date => addCalendarMonths(receivedAt, 3);

/** The effective deadline: the extended one when an extension was granted, otherwise the original. */
const effectiveDueAt = (receivedAt: Date, extended: boolean): Date => (extended ? extendedDueAt(receivedAt) : dueAt(receivedAt));

/**
 * A request is overdue once its effective deadline has passed and it has not finished. The deadline
 * is the extended one when `extendedDueAt` is set, and is computed from `receivedAt` either way.
 */
const isOverdue = (request: { readonly extendedDueAt?: Date; readonly receivedAt: Date; readonly status: RequestStatus }, now: Date): boolean =>
    !isTerminal(request.status) && now.getTime() > effectiveDueAt(request.receivedAt, request.extendedDueAt !== undefined).getTime();

export { addCalendarMonths, dueAt, effectiveDueAt, extendedDueAt, isOverdue };
