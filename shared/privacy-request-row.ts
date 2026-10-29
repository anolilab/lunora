/**
 * One open privacy request as an operator's list shows it: what the app's operator function returns
 * and what the Studio's Privacy requests page renders. Both read it from here, so the page cannot
 * drift from the function that feeds it, and the Studio does not depend on `@lunora/privacy`.
 */
import type { RequestStatus, RequestType } from "./privacy-request-status";

/**
 * Timestamps are epoch milliseconds. `extendedDueAt` is set only when the deadline was extended, so
 * the effective deadline is `extendedDueAt ?? dueAt`.
 */
interface PrivacyRequestRow {
    readonly dueAt: number;
    readonly extendedDueAt?: null | number;
    readonly id: string;
    readonly receivedAt: number;
    readonly status: RequestStatus;
    readonly subjectId: string;
    readonly type: RequestType;
}

export type { PrivacyRequestRow };
