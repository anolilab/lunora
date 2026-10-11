import type { PrivacyPreset, RetentionRule } from "./rules";

/** Decided 2026-10-11, pending TR: the statutory voucher period is 8 years from 2025 (BEG IV). */
const VOUCHER_NOTE = "Decided at 10 years, the conservative value, pending TR on the 8-year statutory period from 2025 (BEG IV).";

/**
 * German statutory retention periods (HGB §257, AO §147). Every rule is pending
 * tax review. The package does not decide which table is a voucher; apps bind
 * tables to these rules explicitly.
 */
export const germany = (): PrivacyPreset => {
    return {
        id: "de",
        retention: [
            {
                citation: "HGB §257(1) Nr. 1, (4); AO §147(1) Nr. 1, (3)",
                id: "de.books",
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(1) Nr. 4, (4); AO §147(1) Nr. 4, (3)",
                id: "de.voucher",
                note: VOUCHER_NOTE,
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(4) for KWG, VAG and WpIG institutions",
                id: "de.voucher.regulated",
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(1) Nr. 2, (4); AO §147(1) Nr. 2, (3)",
                id: "de.correspondence",
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 6,
            },
        ],
    };
};

/**
 * The legal-claims hold. It is opt-in, because it applies only when the controller
 * relies on Art. 17(3)(e) for specific data (LR L11).
 */
export const legalClaimsHold: RetentionRule = {
    citation: "BGB §195, §199(1)",
    id: "de.legalClaims",
    reviewRequired: true,
    start: "endOfCalendarYear",
    years: 3,
};
