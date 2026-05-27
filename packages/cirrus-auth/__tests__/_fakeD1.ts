/* eslint-disable @typescript-eslint/no-explicit-any */
import type { D1DatabaseLike, D1PreparedStatementLike } from "@cirrus/d1";

interface Table {
    columns: string[];
    rows: Record<string, unknown>[];
}

/**
 * Tiny SQL interpreter that supports just enough syntax for the auth package's
 * needs: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX`, `INSERT INTO`,
 * `SELECT … WHERE col = ?`, `DELETE FROM … WHERE …`. Anything more elaborate
 * lands in the runner switch below and throws so tests fail loudly.
 */
export class FakeD1 implements D1DatabaseLike {
    public tables: Map<string, Table> = new Map();

    public prepare(sql: string): D1PreparedStatementLike {
        return this.makeStatement(sql, []);
    }

    public withSession(): never {
        throw new Error("withSession not used in auth");
    }

    public dump(): Record<string, Record<string, unknown>[]> {
        const result: Record<string, Record<string, unknown>[]> = {};

        for (const [name, table] of this.tables.entries()) {
            result[name] = [...table.rows];
        }

        return result;
    }

    private makeStatement(sql: string, binds: unknown[]): D1PreparedStatementLike {
        const self = this;

        const stmt: D1PreparedStatementLike = {
            bind: (...values: unknown[]) => self.makeStatement(sql, [...binds, ...values]),
            first: async <T = unknown>(_column?: string) => {
                const rows = self.run(sql, binds);

                return (rows[0] ?? null) as T | null;
            },
            all: async <T = unknown>() => ({ results: self.run(sql, binds) as T[], success: true }),
            run: async () => {
                self.run(sql, binds);

                return { success: true };
            },
            raw: async () => [],
        };

        return stmt;
    }

    private run(rawSql: string, binds: unknown[]): Record<string, unknown>[] {
        const sql = rawSql.trim().replaceAll(/\s+/g, " ");

        const createTable = /^CREATE TABLE IF NOT EXISTS (\w+) \((.+)\)$/i.exec(sql);

        if (createTable) {
            const [, name, body] = createTable;

            if (!this.tables.has(name!)) {
                const columns = body!.split(",").map((part) => part.trim().split(/\s+/)[0]!);

                this.tables.set(name!, { columns, rows: [] });
            }

            return [];
        }

        if (/^CREATE INDEX/i.test(sql)) {
            return [];
        }

        const insert = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql);

        if (insert) {
            const [, name, columnsList] = insert;
            const table = this.tables.get(name!);

            if (!table) {
                throw new Error(`unknown table ${name}`);
            }

            const columns = columnsList!.split(",").map((column) => column.trim());
            const row: Record<string, unknown> = {};

            for (const [index, column] of columns.entries()) {
                row[column] = binds[index] ?? null;
            }

            table.rows.push(row);

            return [];
        }

        const selectAll = /^SELECT \* FROM (\w+) WHERE (.+)$/i.exec(sql);

        if (selectAll) {
            const [, name, where] = selectAll;
            const table = this.tables.get(name!);

            if (!table) {
                return [];
            }

            return filterRows(table.rows, where!, binds);
        }

        const selectCol = /^SELECT (\w+) FROM (\w+)$/i.exec(sql);

        if (selectCol) {
            const [, , name] = selectCol;
            const table = this.tables.get(name!);

            if (!table) {
                return [];
            }

            return table.rows;
        }

        const del = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(sql);

        if (del) {
            const [, name, where] = del;
            const table = this.tables.get(name!);

            if (!table) {
                return [];
            }

            table.rows = table.rows.filter((row) => !matchWhere(row, where!, binds));

            return [];
        }

        throw new Error(`FakeD1: unsupported SQL: ${sql}`);
    }
}

const filterRows = (rows: Record<string, unknown>[], where: string, binds: unknown[]): Record<string, unknown>[] => {
    return rows.filter((row) => matchWhere(row, where, binds));
};

const matchWhere = (row: Record<string, unknown>, where: string, binds: unknown[]): boolean => {
    const conditions = where.split(/\s+AND\s+/i);
    let bindIndex = 0;

    for (const condition of conditions) {
        const match = /^(\w+)\s*=\s*\?$/.exec(condition.trim());

        if (!match) {
            throw new Error(`FakeD1: unsupported WHERE clause: ${condition}`);
        }

        const [, column] = match;
        const expected = binds[bindIndex];

        bindIndex += 1;

        if (row[column!] !== expected) {
            return false;
        }
    }

    return true;
};
