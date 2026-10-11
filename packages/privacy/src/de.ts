import type { PrivacyPreset, RetentionRule } from "./rules";

/**
 * LEGAL WARNING: these values have NOT been reviewed by a lawyer or a tax adviser.
 * The research behind them is in `docs/legal.mdx`. The statute text was read from
 * gesetze-im-internet.de; the 8-year voucher period comes from the 2024 BEG IV
 * amendment, and the 10-year figure below is a decision, not the statute.
 */

/**
 * The voucher period. The statute sets 8 years for Buchungsbelege (HGB §257(4) S. 1
 * and AO §147(3) S. 1) and 10 years for credit, insurance and securities
 * institutions (HGB §257(4) S. 2). The package keeps 10 years for every voucher
 * because that was decided on 2026-10-11 as the conservative value. Keeping data
 * longer than the law requires is itself a GDPR concern (Art. 5(1)(e)), so the
 * maintainer should confirm 10 or move to 8 for non-regulated businesses.
 */
const VOUCHER_NOTE =
    "Decided at 10 years. The statute sets 8 years for Buchungsbelege (HGB §257(4) S. 1, AO §147(3) S. 1) and 10 years for regulated institutions (HGB §257(4) S. 2). Keeping 10 years for everyone conflicts with GDPR Art. 5(1)(e) for non-regulated businesses. Maintainer decision pending.";

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
                citation: "HGB §257(1) Nr. 1, (4) S. 1; AO §147(1) Nr. 1, (3) S. 1 (10 years, Handelsbücher and Jahresabschlüsse)",
                id: "de.books",
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(1) Nr. 4, (4) S. 1; AO §147(1) Nr. 4, (3) S. 1 (statute: 8 years; see note)",
                id: "de.voucher",
                note: VOUCHER_NOTE,
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(4) S. 2 (10 years for Kreditinstitute, Versicherungsunternehmen, Wertpapierinstitute)",
                id: "de.voucher.regulated",
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: 10,
            },
            {
                citation: "HGB §257(1) Nr. 2, 3, (4) S. 1; AO §147(1) Nr. 2, 3, (3) S. 1 (6 years, Handels- and Geschäftsbriefe)",
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
