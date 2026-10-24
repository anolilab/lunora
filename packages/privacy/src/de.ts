import type { PrivacyPreset, RetentionRule } from "./rules";

/**
 * LEGAL WARNING: these values have NOT been reviewed by a lawyer or a tax adviser.
 * The research behind them is in `docs/legal.mdx`. The statute text was read from
 * gesetze-im-internet.de; the 8-year voucher period comes from the 2024 BEG IV
 * amendment.
 */

/** The statutory voucher period for non-regulated businesses: HGB §257(4) S. 1, AO §147(3) S. 1. */
const STATUTE_VOUCHER_YEARS = 8;

/** Options for the German preset. Every option defaults to the statutory value. */
interface GermanyOptions {
    /**
     * The retention period for Buchungsbelege (vouchers and invoices): 8 is the statute for
     * non-regulated businesses and the default; 10 is the maintainer's longer choice. Regulated
     * institutions keep 10 regardless of this option (HGB §257(4) S. 2).
     */
    readonly voucherYears?: 8 | 10;
}

/** The note on the voucher rule, which says what the statute sets and what the chosen value is. */
const voucherNote = (years: number): string => {
    if (years === STATUTE_VOUCHER_YEARS) {
        return "Set to the statutory 8 years (HGB §257(4) S. 1, AO §147(3) S. 1). Regulated institutions keep 10 years. Confirm with a tax adviser.";
    }

    return "Set to 10 years for every voucher, a maintainer decision. The statute sets 8 years for Buchungsbelege (HGB §257(4) S. 1, AO §147(3) S. 1) and 10 years for regulated institutions. Pass voucherYears: 8 for the statutory period.";
};

/**
 * German statutory retention periods (HGB §257, AO §147). Every rule is pending
 * tax review. The package does not decide which table is a voucher; apps bind
 * tables to these rules explicitly.
 */
const germany = (options: GermanyOptions = {}): PrivacyPreset => {
    const voucherYears = options.voucherYears ?? STATUTE_VOUCHER_YEARS;

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
                note: voucherNote(voucherYears),
                reviewRequired: true,
                start: "endOfCalendarYear",
                years: voucherYears,
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
const legalClaimsHold: RetentionRule = {
    citation: "BGB §195, §199(1)",
    id: "de.legalClaims",
    reviewRequired: true,
    start: "endOfCalendarYear",
    years: 3,
};

export { germany, type GermanyOptions, legalClaimsHold };
