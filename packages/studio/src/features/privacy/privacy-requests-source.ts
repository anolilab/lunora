/**
 * The Privacy requests page: an operator view of open data-subject requests.
 *
 * The Studio cannot call `@lunora/privacy` directly; the app owns it. This module
 * defines the only contract the page depends on. The host app builds a
 * {@link PrivacyRequestsSource} from its own admin functions and passes it to the
 * Studio as `privacyRequests`. Without one, the page renders a "not configured"
 * state and makes no request.
 *
 * Wiring the real source (app side, not built here) needs two app functions,
 * both admin-gated on the app's side. `listOpenPrivacyRequests()` returns the
 * open requests, each with the fields of {@link PrivacyRequestRow}; it is the
 * app's read of what the privacy `admin.open()` API lists. `retryPrivacyRequest(id)`
 * re-runs a failed export or erasure; it is the app's call to `admin.retry(requestId)`.
 *
 * The Studio does not import `@lunora/privacy`, so the types below mirror it by
 * hand. {@link PrivacyRequestType} mirrors `RequestType` and
 * {@link PrivacyRequestStatus} mirrors `RequestStatus`, both in
 * `packages/privacy/src/lifecycle.ts`. A test fails if the status list drifts
 * from that file.
 */

/** Kind of data-subject request. Mirrors `RequestType` in `packages/privacy/src/lifecycle.ts`. */
type PrivacyRequestType = "erasure" | "export";

/**
 * Lifecycle status of a request. Mirrors `RequestStatus` in
 * `packages/privacy/src/lifecycle.ts`. Only `failed` rows offer a Retry action.
 */
type PrivacyRequestStatus = "cancelled" | "completed" | "expired" | "failed" | "grace" | "processing" | "ready" | "received";

/**
 * Every {@link PrivacyRequestStatus}, for exhaustive iteration in tests. The test's
 * `Exclude` check rejects a missing value, and its list comparison rejects an extra one.
 */
const PRIVACY_REQUEST_STATUSES = ["received", "grace", "processing", "ready", "completed", "failed", "cancelled", "expired"] as const;

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
 * Whether a request is past its effective deadline at `now`. An extended request
 * is judged against the extended date, not the original one.
 */
const isPrivacyRequestOverdue = (row: PrivacyRequestRow, now: number): boolean => (row.extendedDueAt ?? row.dueAt) < now;

export type { PrivacyRequestRow, PrivacyRequestsSource, PrivacyRequestStatus, PrivacyRequestType };
export { isPrivacyRequestOverdue, PRIVACY_REQUEST_STATUSES };
