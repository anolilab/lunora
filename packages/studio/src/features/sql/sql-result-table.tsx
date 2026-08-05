import type { ReactElement } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import type { SqlConsoleResult } from "../../lib/admin";
import { CellValue } from "../data/data-grid";

/** The results table for a successful query — sticky header, monospace cells, NULL-aware. */
const SqlResultTable = ({ result }: { readonly result: SqlConsoleResult }): ReactElement => {
    const t = useT();

    if (result.columns.length === 0) {
        // A statement can report rows without column metadata; say how many rather
        // than rendering an empty line.
        return <p className="p-4 text-sm text-muted-foreground">{t("{count} rows", { count: result.rowCount })}</p>;
    }

    return (
        <Table data-testid="sql-rows">
            <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                    {result.columns.map((column) => (
                        <TableHead key={column}>{column}</TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {result.rows.map((row, rowIndex) => (
                    // eslint-disable-next-line react-x/no-array-index-key -- a raw SQL result row has no stable identity; position is the only key
                    <TableRow data-testid="sql-row" key={rowIndex}>
                        {result.columns.map((column) => (
                            <TableCell className="max-w-md truncate font-mono text-xs" key={column}>
                                <CellValue value={row[column]} />
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
};

export default SqlResultTable;
