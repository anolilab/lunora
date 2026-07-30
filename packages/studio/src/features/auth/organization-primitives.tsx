/*
 * Shared shell + dialog vocabulary for the organization page.
 *
 * `SectionCard` is the frame all four sections render inside, and `DialogState`
 * is the one channel they report their intents through — both belong to the page
 * as a whole rather than to any single section.
 */

import type { ReactElement, ReactNode } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { formatCell } from "../../lib/internal";
import type { Row } from "./types";

interface Column {
    readonly className?: string;
    readonly head: string;
    readonly render: (row: Row) => ReactNode;
}

/** A titled card with an optional header action (the section wrapper for each management list). */
const SectionCard = ({ action, children, heading, testId }: { action?: ReactNode; children: ReactNode; heading: string; testId: string }): ReactElement => (
    <Card className="overflow-hidden py-0" data-testid={testId}>
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{heading}</span>
            {action !== undefined && <div className="flex items-center gap-2">{action}</div>}
        </header>
        <CardContent className="px-0">{children}</CardContent>
    </Card>
);

/** Which secondary dialog (if any) the detail view has open, plus its row context. */
type DialogState =
    | null
    | { kind: "add-member" }
    | { action: () => Promise<void>; kind: "confirm"; message: string; testId: string; title: string }
    | { kind: "invite-member" }
    | { kind: "member-role"; member: Row }
    | { kind: "role-create" }
    | { kind: "role-edit"; role: Row }
    | { kind: "team-add-member"; teamId: string }
    | { kind: "team-create" }
    | { kind: "team-rename"; team: Row };

/** A table of rows with a per-row actions cell, keyed by the row's `id`. */
const ManagedTable = ({
    columns,
    rowActions,
    rowPrefix,
    rows,
}: {
    columns: Column[];
    rowActions: (row: Row) => ReactNode;
    rowPrefix: string;
    rows: Row[];
}): ReactElement => {
    const t = useT();

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    {columns.map((column) => (
                        <TableHead key={column.head}>{column.head}</TableHead>
                    ))}
                    <TableHead aria-label={t("Actions")} />
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => {
                    const id = formatCell(row["id"]);

                    return (
                        <TableRow data-testid={`${rowPrefix}-${id}`} key={id}>
                            {columns.map((column) => (
                                <TableCell className={column.className} key={column.head}>
                                    {column.render(row)}
                                </TableCell>
                            ))}
                            <TableCell>
                                <div className="flex justify-end gap-1">{rowActions(row)}</div>
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
};

export type { Column, DialogState };
export { ManagedTable, SectionCard };
