/**
 * The privacy coverage rule: every table that holds user data must be either
 * exported and erased by a dataset, or excluded with a written reason. A table in
 * neither list is a problem, because erasure would silently miss it.
 *
 * Two places run the rule and must agree: `@lunora/privacy` at runtime
 * (`definePrivacy().coverage`) and `@lunora/codegen` at build time, which reads the
 * same declarations as literals. Codegen must not depend on the runtime package, so
 * the rule lives here once, with no imports, and the bundler inlines it into both.
 */

/** How a table is accounted for: exported and erased by a dataset, or excluded with the reason the reviewer reads. */
type TableClassification = { readonly dataset: string } | { readonly excluded: string };

/** One problem the coverage check found. */
interface CoverageProblem {
    /** `unclassified`: no dataset and no exclusion. `excluded_without_reason`: excluded with a blank reason. */
    readonly code: "excluded_without_reason" | "unclassified";
    readonly table: string;
}

/** The better-auth tables `authDataset()` covers when no table is renamed. */
const AUTH_DEFAULT_TABLES = ["account", "apikey", "member", "passkey", "session", "teamMember", "twoFactor", "user"] as const;

/**
 * The classification of every listed table. Datasets are applied first and exclusions
 * after, so a table that is both is excluded.
 */
const classifyTables = (
    datasets: Iterable<readonly [table: string, datasetId: string]>,
    exclusions: Iterable<readonly [table: string, reason: string]>,
): Record<string, TableClassification> => {
    const classifications: Record<string, TableClassification> = {};

    for (const [table, dataset] of datasets) {
        classifications[table] = { dataset };
    }

    for (const [table, excluded] of exclusions) {
        classifications[table] = { excluded };
    }

    return classifications;
};

/**
 * Check every table in `tables` against its classification. A table with no entry is
 * unclassified; an exclusion with a blank reason is refused, because the reason is what
 * the reviewer reads in the Article 30 draft.
 */
const checkCoverage = (
    tables: ReadonlyArray<string>,
    classifications: Readonly<Record<string, TableClassification | undefined>>,
): ReadonlyArray<CoverageProblem> => {
    const problems: CoverageProblem[] = [];

    for (const table of tables) {
        const classification = classifications[table];

        if (classification === undefined) {
            problems.push({ code: "unclassified", table });
        } else if ("excluded" in classification && classification.excluded.trim() === "") {
            problems.push({ code: "excluded_without_reason", table });
        }
    }

    return problems;
};

export { AUTH_DEFAULT_TABLES, checkCoverage, classifyTables };
export type { CoverageProblem, TableClassification };
