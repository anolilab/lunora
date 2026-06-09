import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import type { SqlConsoleResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Button } from "./components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { CellValue, GridContainer } from "./data-grid";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";

interface SqlEditorPanelProps {
    /** Shard key the query runs against on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);

/**
 * A read-only SQL editor over a shard's SQLite — the Supabase/Outerbase SQL-editor
 * analog. An editor pane (⌘↵ / Ctrl+↵ to run) over a results grid; the server
 * rejects anything but `SELECT` / `WITH` / `EXPLAIN`, since raw writes would
 * bypass the schema-aware writer and desync the FTS / aggregate / rank shadow
 * tables (use the Data grid's inline edit for mutations). Admin-gated like every
 * other studio admin call.
 */
export const SqlEditorPanel = ({ initialShardKey }: SqlEditorPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [query, setQuery] = useState<string>("SELECT name FROM sqlite_master WHERE type = 'table';");
    const [result, setResult] = useState<null | SqlConsoleResult>(null);
    const [error, setError] = useState<null | string>(null);
    const [running, setRunning] = useState<boolean>(false);

    const run = useCallback(async (): Promise<void> => {
        if (query.trim() === "") {
            return;
        }

        setRunning(true);

        try {
            const next = (await client.query(RUN_SQL, { sql: query }, callOptions(shardKey))) as SqlConsoleResult;

            setResult(next);
            setError(null);
            recordShard(shardKey);
        } catch (error_: unknown) {
            setResult(null);
            setError(errorMessage(error_));
        } finally {
            setRunning(false);
        }
    }, [client, query, shardKey]);

    const onRun = useCallback((): void => {
        fireAndForget(run());
    }, [run]);

    const onChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        setQuery(event.target.value);
    }, []);

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                fireAndForget(run());
            }
        },
        [run],
    );

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-sql-editor">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="sql-shard-input" value={shardKey} />
                <Button data-testid="sql-run" disabled={running} onClick={onRun} size="sm" type="button">
                    {running ? t("Running…") : t("Run ⌘↵")}
                </Button>
                <span className="text-xs text-muted-foreground">{t("Read-only — only SELECT, WITH, and EXPLAIN queries run here.")}</span>
            </div>

            <textarea
                aria-label={t("SQL query")}
                className="min-h-32 w-full rounded-md border border-border bg-background p-3 font-mono text-xs outline-none focus-visible:border-ring"
                data-testid="sql-input"
                onChange={onChange}
                onKeyDown={onKeyDown}
                placeholder="SELECT * FROM …"
                spellCheck={false}
                value={query}
            />

            {error !== null && (
                <p
                    className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
                    data-testid="sql-error"
                    role="alert"
                >
                    {error}
                </p>
            )}

            {result !== null && (
                <div className="flex flex-col gap-2" data-testid="sql-result">
                    <span className="text-xs text-muted-foreground" data-testid="sql-count">
                        {result.truncated
                            ? t("Showing the first {max} of {count} rows.", { count: result.rowCount, max: result.rows.length })
                            : t("{count} rows", { count: result.rowCount })}
                    </span>

                    {result.columns.length === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                            {t("No rows returned.")}
                        </p>
                    ) : (
                        <GridContainer>
                            <Table data-testid="sql-rows">
                                <TableHeader>
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
                                                <TableCell className="max-w-xs truncate font-mono text-xs" key={column}>
                                                    <CellValue value={row[column]} />
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </GridContainer>
                    )}
                </div>
            )}
        </div>
    );
};

export type { SqlEditorPanelProps };
