/**
 * The decision the scheduled domain check makes for one domain: given its stored
 * state and a fresh DNS verdict, what to write and whether to announce it. Pure,
 * so the flap protection and the transitions are unit-testable without DNS.
 */

/** Consecutive failed checks before a verified domain is marked unverified. One bad lookup is not an outage. */
export const FAILURES_BEFORE_UNVERIFIED = 2;

/** The slice of a domain row the decision reads. */
export interface DomainCheckState {
    failedChecks?: number;
    verifiedAt?: number;
}

/** What the check writes back, and the notification it earns, if any. */
export interface DomainCheckOutcome {
    /** Fields to patch on the domain row. `verifiedAt: undefined` clears it. */
    patch: { failedChecks: number; verifiedAt?: number | undefined };
    transition: "domain.failed" | "domain.verified" | null;
}

/**
 * Apply one DNS verdict to a domain. A domain is announced `domain.verified` the
 * first time it passes, and `domain.failed` once it has failed
 * {@link FAILURES_BEFORE_UNVERIFIED} checks in a row after passing. A domain that
 * was never verified stays quiet while it is still pending.
 */
export const reconcileDomain = (state: DomainCheckState, verified: boolean, now: number): DomainCheckOutcome => {
    if (verified) {
        if (state.verifiedAt === undefined) {
            return { patch: { failedChecks: 0, verifiedAt: now }, transition: "domain.verified" };
        }

        return { patch: { failedChecks: 0, verifiedAt: state.verifiedAt }, transition: null };
    }

    if (state.verifiedAt === undefined) {
        return { patch: { failedChecks: 0 }, transition: null };
    }

    const failedChecks = (state.failedChecks ?? 0) + 1;

    if (failedChecks < FAILURES_BEFORE_UNVERIFIED) {
        return { patch: { failedChecks, verifiedAt: state.verifiedAt }, transition: null };
    }

    return { patch: { failedChecks: 0, verifiedAt: undefined }, transition: "domain.failed" };
};

/** The one-line detail a domain notification carries. Shared with the manual verify path. */
export const domainNotificationDetail = (event: "domain.failed" | "domain.verified", hostname: string): string =>
    event === "domain.verified"
        ? `${hostname} now serves the app.`
        : `${hostname} no longer validates. Check its DNS records in the domain settings.`;
