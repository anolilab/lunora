/**
 * The request lifecycle as pure functions: which transitions are legal, when a
 * request can be cancelled or extended, and when erasure may start. The
 * mutations that persist a request call these, so the rules are tested without a
 * database.
 */
import { LunoraError } from "@lunora/errors";

import type { RequestStatus, RequestType } from "../../../shared/privacy-request-status";
import { isTerminal, REQUEST_STATUSES } from "../../../shared/privacy-request-status";
import { DAY_MS } from "./deadlines";

/** The deadlines a request stores when it is opened and extended. */
interface RequestDeadlines {
    readonly dueAt: Date;
    readonly extendedDueAt?: Date;
}

/**
 * Where a subject may cancel, by request type, and the only statuses that move to `cancelled`. An export
 * is cancelled only before its run starts: a processing export is not cancelled, because the run would
 * otherwise write over the cancellation. An erasure is cancelled only during its grace window; after
 * it, rows are being erased and cancelling cannot restore them.
 */
const CANCEL_WINDOW: Readonly<Record<RequestType, RequestStatus>> = { erasure: "grace", export: "received" };

const CANCELLABLE: ReadonlySet<RequestStatus> = new Set(Object.values(CANCEL_WINDOW));

/**
 * Every other transition the package makes, one entry per status in `REQUEST_STATUSES`. `failed` is
 * not terminal: an operator retries it into `processing`, and the Art. 12(3) clock keeps running. A
 * run can fail before it starts processing (a missing secret), so `received` and `grace` may move to
 * `failed` too. A `ready` export only expires: nothing runs it again or cancels it.
 */
const TRANSITIONS: Readonly<Record<RequestStatus, ReadonlyArray<RequestStatus>>> = {
    cancelled: [],
    completed: [],
    expired: [],
    failed: ["processing"],
    grace: ["failed", "processing"],
    processing: ["completed", "failed", "ready"],
    ready: ["expired"],
    received: ["failed", "processing"],
};

/** Thrown when a transition is not in {@link TRANSITIONS}. An `UNPROCESSABLE` error, like every refused request change. */
class InvalidTransitionError extends LunoraError {
    public constructor(
        public readonly from: RequestStatus,
        public readonly to: RequestStatus,
    ) {
        super("UNPROCESSABLE", `A privacy request cannot move from "${from}" to "${to}".`);
        this.name = "InvalidTransitionError";
    }
}

/** Whether a value read from outside the package (a step result, a row) is a known status. */
const isRequestStatus = (value: string): value is RequestStatus => (REQUEST_STATUSES as ReadonlyArray<string>).includes(value);

/** Every status that is not terminal, for a `listOpen` that reads a status index once per status. */
const OPEN_STATUSES: ReadonlyArray<RequestStatus> = REQUEST_STATUSES.filter((status) => !isTerminal(status));

/** Whether the move is allowed: a cancel from a {@link CANCEL_WINDOW} status, or an edge in {@link TRANSITIONS}. */
const canTransition = (from: RequestStatus, to: RequestStatus): boolean => (to === "cancelled" ? CANCELLABLE.has(from) : TRANSITIONS[from].includes(to));

/** Check a transition and return the new status, or throw {@link InvalidTransitionError}. */
const transition = (from: RequestStatus, to: RequestStatus): RequestStatus => {
    if (!canTransition(from, to)) {
        throw new InvalidTransitionError(from, to);
    }

    return to;
};

/** Whether a subject may cancel a request of this type in this status. See {@link CANCEL_WINDOW}. */
const canCancel = (type: RequestType, status: RequestStatus): boolean => CANCEL_WINDOW[type] === status;

/**
 * Art. 12(3) sentence 2: the controller may extend once, and only while the
 * original month has not run out. The extension must be notified within the
 * first month, and that notice is what this rule guards.
 */
const canExtend = (request: RequestDeadlines, now: Date): boolean => request.extendedDueAt === undefined && now.getTime() < request.dueAt.getTime();

/** The smallest drain budget, in days. Enough for a batched erasure and its completion notice. */
const MIN_DRAIN_BUDGET_DAYS = 3;

/**
 * When erasure may start. The configured grace runs from receipt, but it ends at
 * least `drainBudgetDays` before the Art. 12(3) deadline, so the erasure and its
 * notice fall inside the month. With the 14-day grace this cap never binds,
 * because the shortest month leaves 25 days after the budget.
 */
const erasureGraceUntil = (receivedAt: Date, due: Date, graceDays: number, drainBudgetDays: number): Date => {
    const budgetDays = Math.max(MIN_DRAIN_BUDGET_DAYS, drainBudgetDays);
    const configured = receivedAt.getTime() + graceDays * DAY_MS;
    const capped = due.getTime() - budgetDays * DAY_MS;

    return new Date(Math.min(configured, capped));
};

export { canCancel, canExtend, canTransition, erasureGraceUntil, InvalidTransitionError, isRequestStatus, MIN_DRAIN_BUDGET_DAYS, OPEN_STATUSES, transition };

/*
 * The status list, the terminal set and the overdue rule are shared with the Studio, which must not
 * depend on this package. They are re-exported here so the package reads one definition of each.
 */
export { awaitsResponse, effectiveDueAt, isOverdue } from "../../../shared/privacy-deadlines";
export type { RequestStatus, RequestType } from "../../../shared/privacy-request-status";
export { isTerminal } from "../../../shared/privacy-request-status";
