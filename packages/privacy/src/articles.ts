/**
 * Which GDPR articles a dataset's export falls under. One export serves both
 * Art. 15 (access, every origin) and Art. 20 (portability, data the subject
 * provided, on consent or contract, by automated means).
 */

/** Where a dataset's data came from. */
export type DataOrigin = "provided" | "observed" | "derived" | "inferred";

/** The Art. 6(1) basis the data is processed on. */
export type LegalBasis = "consent" | "contract" | "legal_obligation" | "legitimate_interest";

/** The articles a dataset is exported under. */
export type ExportArticle = "15" | "20";

/**
 * Art. 15 always applies, because it covers every origin, including derived and
 * inferred data. Art. 20 applies when the subject provided the data (or it was
 * observed, which WP242 rev.01 treats as provided), and it was processed on
 * consent or contract. Whether "observed" counts as "provided" is a legal review
 * item (L7), so that reading is kept in one place.
 */
export const articlesFor = (origin: DataOrigin, legalBasis: LegalBasis): ReadonlyArray<ExportArticle> => {
    const portable = (origin === "provided" || origin === "observed") && (legalBasis === "consent" || legalBasis === "contract");

    return portable ? ["15", "20"] : ["15"];
};
