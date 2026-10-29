/**
 * When a privacy request is overdue.
 *
 * `@lunora/privacy` judges a request overdue in its deadline sweep, and the Studio's
 * Privacy requests page flags the same requests. Both read the deadline the request
 * stored when it was opened (and, once extended, the extended one), so a policy that
 * sets the response window is honoured in both places and the two cannot disagree.
 * The Studio must not depend on the runtime package, so the rule lives here and the
 * bundler inlines it into each.
 */
import type { RequestStatus } from "./privacy-request-status";
import { isTerminal } from "./privacy-request-status";

/** The deadline a request answers to: the extended one once an extension was granted, otherwise the original. */
const effectiveDueAt = (request: { readonly dueAt: Date; readonly extendedDueAt?: Date }): Date => request.extendedDueAt ?? request.dueAt;

/**
 * Whether the controller still owes the subject an answer. A terminal request is finished, and a
 * `ready` export has been answered: the subject holds a download link.
 */
const awaitsResponse = (status: RequestStatus): boolean => !isTerminal(status) && status !== "ready";

/** A request is overdue once its effective deadline has passed while the controller still owes the answer. */
const isOverdue = (request: { readonly dueAt: Date; readonly extendedDueAt?: Date; readonly status: RequestStatus }, now: Date): boolean =>
    awaitsResponse(request.status) && now.getTime() > effectiveDueAt(request).getTime();

export { awaitsResponse, effectiveDueAt, isOverdue };
