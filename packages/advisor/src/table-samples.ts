/**
 * A bounded sample of rows from one table, fed into the constraint-validator
 * lint by the studio backend (via `readTablePage`). The cap prevents unbounded
 * scans while still catching obvious violations on small-to-medium tables.
 *
 * The studio notes the cap to the operator when the row count exceeds it
 * (`truncated: true`), so violations on rows beyond the sample window are not
 * silently missed — the finding description mentions the cap.
 */
export interface AdvisorTableSample {
    /** The cap applied; equals `rows.length` when not truncated. */
    readonly cap: number;

    /**
     * The row ids of every existing row in this table (bounded to `cap`), used
     * for FK referential-integrity checks: if a FK value does not appear in the
     * target table's `existingIds`, it is a dangling reference.
     */
    readonly existingIds: ReadonlySet<string>;
    /** Sampled rows (up to `cap`). Each row includes `_id` and all declared columns. */
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    /** The table's name. */
    readonly table: string;
    /** Whether more rows exist beyond the cap. */
    readonly truncated: boolean;
}
