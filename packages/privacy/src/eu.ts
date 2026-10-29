import { LunoraError } from "@lunora/errors";

import type { PrivacyPreset } from "./rules";

/** Art. 12(3): months from receipt to the response. LR review (L1) is still open. */
export const EU_RESPONSE_MONTHS = 1;

/** The default erasure grace in days: decision D3. Capped before the deadline (L9). */
export const DEFAULT_ERASURE_GRACE_DAYS = 14;

/** The longest grace an app may set, in days. Beyond this the cap is the only protection. */
export const MAX_ERASURE_GRACE_DAYS = 14;

/** Options for the EU preset. Every option defaults to the decided value. */
export interface EuOptions {
    /** Days between an accepted erasure request and the start of erasure. Integer, 0 to 14. Default 14. */
    readonly erasureGraceDays?: number;
}

/**
 * Refuse a grace that is not a whole number of days in range. Used by the preset and
 * by `definePrivacy`, so both enforce the same range.
 */
export const checkErasureGraceDays = (days: number): number => {
    if (!Number.isInteger(days) || days < 0 || days > MAX_ERASURE_GRACE_DAYS) {
        throw new LunoraError(
            "BAD_REQUEST",
            `The erasure grace must be a whole number of days from 0 to ${String(MAX_ERASURE_GRACE_DAYS)}; got ${String(days)}.`,
        );
    }

    return days;
};

/**
 * EU GDPR preset: the response time and the erasure grace. Every value carries
 * `reviewRequired`. The legal basis for each value is in `docs/legal.mdx`.
 */
export const eu = (options: EuOptions = {}): PrivacyPreset => {
    // Art. 12(3) sentence 2: two further months with reasons given in the first month.
    const erasureGraceDays = checkErasureGraceDays(options.erasureGraceDays ?? DEFAULT_ERASURE_GRACE_DAYS);

    return {
        id: "eu",
        policy: { erasureGraceDays, extensionMonths: 2, responseMonths: EU_RESPONSE_MONTHS, reviewRequired: true },
        retention: [],
    };
};
