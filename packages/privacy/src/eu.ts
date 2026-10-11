import type { PrivacyPreset } from "./rules";

/**
 * EU GDPR preset: the response time and the erasure grace. Every value carries
 * `reviewRequired`, and the citations are in the rule comments below.
 */
/** Art. 12(3): months from receipt to the response. LR review (L1) is still open. */
export const EU_RESPONSE_MONTHS = 1;

export const eu = (): PrivacyPreset => {
    // Art. 12(3) sentence 2: two further months with reasons given in the first month.
    // Erasure grace: a 14-day window (decision D3), capped before the deadline (L9).
    return {
        id: "eu",
        policy: { erasureGraceDays: 14, extensionMonths: 2, responseMonths: EU_RESPONSE_MONTHS, reviewRequired: true },
        retention: [],
    };
};
