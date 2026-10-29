/**
 * The statuses a privacy request moves through, and which of them are terminal.
 *
 * `@lunora/privacy` stores them and the Studio's Privacy requests page renders them.
 * The Studio must not depend on the runtime package, so both read the list from here
 * and the bundler inlines it into each. A status added here reaches both, and the
 * Studio's exhaustive badge map fails to compile until it has a variant.
 */

/** Every status, in lifecycle order. */
const REQUEST_STATUSES = ["received", "grace", "processing", "ready", "completed", "failed", "cancelled", "expired"] as const;

type RequestStatus = (typeof REQUEST_STATUSES)[number];

type RequestType = "erasure" | "export";

/** A request in a terminal state takes no further transitions. `expired` is a ready export whose files were removed. */
const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["cancelled", "completed", "expired"]);

const isTerminal = (status: RequestStatus): boolean => TERMINAL_STATUSES.has(status);

export { isTerminal, REQUEST_STATUSES };
export type { RequestStatus, RequestType };
