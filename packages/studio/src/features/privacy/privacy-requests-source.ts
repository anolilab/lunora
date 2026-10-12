/**
 * The Privacy requests page: an operator view of open data-subject requests.
 *
 * The Studio cannot call `@lunora/privacy` directly; the app owns it. This module
 * defines the only contract the page depends on. The host app builds a
 * {@link PrivacyRequestsSource} from its own operator functions and passes it to the
 * Studio as `privacyRequests`. Without one, the page renders a "not configured"
 * state and makes no request. `examples/privacy` wires both functions
 * (`lunora/admin.ts`): the open list is the privacy `admin.open()` API, and a retry
 * is its `admin.retry(requestId)`.
 *
 * The status list and the overdue rule come from `shared/`, written for the privacy
 * package to read too, so the Studio neither mirrors them by hand nor depends on the
 * package. Both judge a request by the deadline it stored, so the page and the
 * package's deadline sweep cannot disagree about which request is overdue.
 */
import { isOverdue } from "../../../../../shared/privacy-deadlines";
import type { RequestStatus, RequestType } from "../../../../../shared/privacy-request-status";
import { REQUEST_STATUSES } from "../../../../../shared/privacy-request-status";

/** Kind of data-subject request. */
type PrivacyRequestType = RequestType;

/** Lifecycle status of a request. Only `failed` rows offer a Retry action. */
type PrivacyRequestStatus = RequestStatus;

/** Every {@link PrivacyRequestStatus}, for exhaustive iteration. */
const PRIVACY_REQUEST_STATUSES: ReadonlyArray<PrivacyRequestStatus> = REQUEST_STATUSES;

/**
 * One open request as the Studio displays it. Timestamps are epoch milliseconds.
 * `extendedDueAt` is set only when the deadline was extended, so the effective
 * deadline is `extendedDueAt ?? dueAt`.
 */
interface PrivacyRequestRow {
    readonly dueAt: number;
    readonly extendedDueAt?: null | number;
    readonly id: string;
    readonly receivedAt: number;
    readonly status: PrivacyRequestStatus;
    readonly subjectId: string;
    readonly type: PrivacyRequestType;
}

/** What the Studio's Privacy requests page reads and writes. */
interface PrivacyRequestsSource {
    /** The open requests, in any order; the page sorts nothing. */
    listOpenPrivacyRequests: () => Promise<ReadonlyArray<PrivacyRequestRow>>;
    /** Re-run a failed request. Rejects with the server's message on failure. */
    retryPrivacyRequest: (id: string) => Promise<unknown>;
}

/**
 * Whether a request is past its effective deadline at `now`, by the package's own rule. An
 * extended request is judged against the extended date; a terminal request or a ready
 * export is never overdue.
 */
const isPrivacyRequestOverdue = (row: PrivacyRequestRow, now: number): boolean =>
    isOverdue(
        {
            dueAt: new Date(row.dueAt),
            status: row.status,
            ...(row.extendedDueAt === undefined || row.extendedDueAt === null ? {} : { extendedDueAt: new Date(row.extendedDueAt) }),
        },
        new Date(now),
    );

export type { PrivacyRequestRow, PrivacyRequestsSource, PrivacyRequestStatus, PrivacyRequestType };
export { isPrivacyRequestOverdue, PRIVACY_REQUEST_STATUSES };
