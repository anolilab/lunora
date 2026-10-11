/**
 * The coverage check: every table that holds user data must be either exported
 * and erased by a dataset, or excluded with a written reason. A table in neither
 * list is a problem, because erasure would silently miss it.
 */

/** How a table is accounted for. */
export interface TableClassification {
    /** The dataset that exports and erases the table. */
    readonly dataset?: string;
    /** Why the table is left out of the export and erasure. Required when there is no dataset. */
    readonly excluded?: string;
}

/** One problem the coverage check found. */
export interface CoverageProblem {
    /** `unclassified`: no dataset and no exclusion. `excluded_without_reason`: excluded with an empty reason. */
    readonly code: "unclassified" | "excluded_without_reason";
    readonly table: string;
}

/**
 * Check every owned table in `tables` against its classification. Tables with no
 * entry are unclassified; an exclusion with a blank reason is refused, because
 * the reason is what the reviewer reads in the Article 30 draft.
 */
export const checkCoverage = (
    tables: ReadonlyArray<string>,
    classifications: Readonly<Record<string, TableClassification | undefined>>,
): ReadonlyArray<CoverageProblem> => {
    const problems: CoverageProblem[] = [];

    for (const table of tables) {
        const classification = classifications[table];

        if (classification === undefined || (classification.dataset === undefined && classification.excluded === undefined)) {
            problems.push({ code: "unclassified", table });

            continue;
        }

        if (classification.dataset === undefined && (classification.excluded ?? "").trim() === "") {
            problems.push({ code: "excluded_without_reason", table });
        }
    }

    return problems;
};
