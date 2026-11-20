/**
 * A mutable in-memory {@link ControlPlaneStore}: writes land in the tables and
 * later reads see them. For suites that drive a sequence (a box session, a
 * report replayed twice) rather than one call. `where` matches by equality, the
 * `{ gt, gte, lt, lte }` operators and an `OR` of such clauses; SQL NULL is modelled as `null`.
 */
import type { ControlPlaneStore } from "../../src/d1-store";

type Row = Record<string, unknown>;

type Comparison = { gt?: number; gte?: number; lt?: number; lte?: number };

const isComparison = (value: unknown): value is Comparison =>
    typeof value === "object" && value !== null && ["gt", "gte", "lt", "lte"].some((key) => key in value);

const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, expected]) => {
        if (field === "OR") {
            return (expected as Row[]).some((clause) => matches(row, clause));
        }

        const actual = row[field] ?? null;

        if (!isComparison(expected)) {
            return actual === (expected ?? null);
        }

        if (typeof actual !== "number") {
            return false;
        }

        return (
            (expected.gt === undefined || actual > expected.gt) &&
            (expected.gte === undefined || actual >= expected.gte) &&
            (expected.lt === undefined || actual < expected.lt) &&
            (expected.lte === undefined || actual <= expected.lte)
        );
    });

export interface MemoryStore extends ControlPlaneStore {
    /** Every table's rows, live. */
    tables: Record<string, Row[]>;
}

export const memoryStore = (seed: Record<string, Row[]> = {}): MemoryStore => {
    const tables: Record<string, Row[]> = Object.fromEntries(
        Object.entries(seed).map(([name, rows]) => [
            name,
            rows.map((row) => {
                return { ...row };
            }),
        ]),
    );
    let sequence = 0;
    const find = (id: string): Row | undefined =>
        Object.values(tables)
            .flat()
            .find((row) => row["_id"] === id);

    return {
        delete: (_table, id) => {
            for (const rows of Object.values(tables)) {
                const index = rows.findIndex((row) => row["_id"] === id);

                if (index !== -1) {
                    rows.splice(index, 1);
                }
            }

            return Promise.resolve();
        },
        findMany: (table, args) => Promise.resolve({ isDone: true, page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) }),
        get: (_table, id) => Promise.resolve(find(id) ?? null),
        insert: (table, document) => {
            sequence += 1;

            const id = `${table}_${String(sequence)}`;

            const rows = tables[table] ?? [];

            rows.push({ ...document, _id: id });
            tables[table] = rows;

            return Promise.resolve(id);
        },
        patch: (_table, id, patch) => {
            const row = find(id);

            if (row === undefined) {
                return Promise.reject(new Error(`no row ${id}`));
            }

            for (const [field, value] of Object.entries(patch)) {
                if (value === undefined) {
                    return Promise.reject(new Error(`Cannot patch field '${field}' to undefined`));
                }

                row[field] = value;
            }

            return Promise.resolve();
        },
        patchIf: (_table, id, { patch, where }) => {
            const row = find(id);

            if (row === undefined || !matches(row, where)) {
                return Promise.resolve({ applied: false });
            }

            Object.assign(row, patch);

            return Promise.resolve({ applied: true });
        },
        tables,
    };
};
