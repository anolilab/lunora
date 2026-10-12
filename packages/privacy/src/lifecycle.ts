/**
 * The request lifecycle as pure functions: which transitions are legal, when a
 * request can be cancelled or extended, and when erasure may start. The
 * mutations that persist a request call these, so the rules are tested without a
 * database.
 */
import { dueAt, extendedDueAt } from "./deadlines";

type RequestType = "export" | "erasure";

type RequestStatus = "received" | "grace" | "processing" | "ready" | "completed" | "failed" | "cancelled" | "expired";

/** A request in a terminal state takes no further transitions. `expired` is a ready export whose files were removed. */
const TERMINAL: ReadonlySet<RequestStatus> = new Set(["cancelled", "completed", "expired"]);

/**
 * The transitions the package allows. `failed` is not terminal: an operator can
 * retry the work, and the Art. 12(3) clock keeps running throughout.
 */
const TRANSITIONS: Readonly<Record<RequestStatus, ReadonlyArray<RequestStatus>>> = {
    cancelled: [],
    completed: [],
    expired: [],
    failed: ["processing"],
    grace: ["cancelled", "processing"],
    processing: ["completed", "failed", "ready"],
    ready: ["cancelled", "expired", "processing"],
    received: ["cancelled", "grace", "processing"],
};

/** Thrown when a transition is not in {@link TRANSITIONS}. */
class InvalidTransitionError extends Error {
    public constructor(
        public readonly from: RequestStatus,
        public readonly to: RequestStatus,
    ) {
        super(`A privacy request cannot move from "${from}" to "${to}".`);
        this.name = "InvalidTransitionError";
    }
}

const isTerminal = (status: RequestStatus): boolean => TERMINAL.has(status);

/** Check a transition and return the new status, or throw {@link InvalidTransitionError}. */
const transition = (from: RequestStatus, to: RequestStatus): RequestStatus => {
    if (!TRANSITIONS[from].includes(to)) {
        throw new InvalidTransitionError(from, to);
    }

    return to;
};

/**
 * A subject may cancel while the work has not yet been handed over: an export up
 * to the point it is ready, an erasure only during its grace window. After that,
 * the rows are being erased and cancelling cannot restore them.
 */
const canCancel = (type: RequestType, status: RequestStatus): boolean => {
    if (type === "erasure") {
        return status === "grace";
    }

    // Only before the run starts: a processing or ready export is not cancelled, because the run
    // would otherwise write over the cancellation. Plan §4.5 says "before ready".
    return status === "received";
};

/**
 * Art. 12(3) sentence 2: the controller may extend once, and only while the
 * original month has not run out. The extension must be notified within the
 * first month, and that notice is what this rule guards.
 */
const canExtend = (receivedAt: Date, now: Date, alreadyExtended: boolean): boolean => !alreadyExtended && now.getTime() < dueAt(receivedAt).getTime();

/** The effective deadline: the extended one when an extension was granted, otherwise the original. */
const effectiveDueAt = (receivedAt: Date, extended: boolean): Date => (extended ? extendedDueAt(receivedAt) : dueAt(receivedAt));

/**
 * A request is overdue once its effective deadline has passed and it has not finished. The deadline
 * is the extended one when `extendedDueAt` is set, and is computed from `receivedAt` either way.
 */
const isOverdue = (request: { readonly extendedDueAt?: Date; readonly receivedAt: Date; readonly status: RequestStatus }, now: Date): boolean =>
    !isTerminal(request.status) && now.getTime() > effectiveDueAt(request.receivedAt, request.extendedDueAt !== undefined).getTime();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The smallest drain budget, in days. Enough for a batched erasure and its completion notice. */
const MIN_DRAIN_BUDGET_DAYS = 3;

/**
 * When erasure may start. The configured grace runs from receipt, but it ends at
 * least `drainBudgetDays` before the Art. 12(3) deadline, so the erasure and its
 * notice fall inside the month. With the 14-day grace this cap never binds,
 * because the shortest month leaves 25 days after the budget.
 */
const erasureGraceUntil = (receivedAt: Date, graceDays: number, drainBudgetDays: number): Date => {
    const budgetDays = Math.max(MIN_DRAIN_BUDGET_DAYS, drainBudgetDays);
    const configured = receivedAt.getTime() + graceDays * DAY_MS;
    const capped = dueAt(receivedAt).getTime() - budgetDays * DAY_MS;

    return new Date(Math.min(configured, capped));
};

export {
    canCancel,
    canExtend,
    effectiveDueAt,
    erasureGraceUntil,
    InvalidTransitionError,
    isOverdue,
    isTerminal,
    MIN_DRAIN_BUDGET_DAYS,
    type RequestStatus,
    type RequestType,
    transition,
};
