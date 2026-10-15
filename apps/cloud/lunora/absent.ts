/**
 * A stored row with each SQL NULL read as an absent key. A `.global()` table answers
 * `null` for an unset column (the generated document type says so), while the view and
 * domain types a function returns say `undefined`. A boundary that copies a row into one
 * of those types runs it through here, so the null-or-absent choice is made once.
 */
export type AbsentForNull<T> = {
    [K in keyof T]: Exclude<T[K], null> | (null extends T[K] ? undefined : never);
};

export const absentForNull = <T extends object>(row: T): AbsentForNull<T> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? undefined : value])) as AbsentForNull<T>;
