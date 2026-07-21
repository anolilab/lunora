import type { PipelineLogCursor, PipelineLogQuery, PipelineLogRow } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useEffect, useReducer, useRef, useState } from "react";

import { LOG_ARCHIVE_NOT_CONFIGURED } from "../../../../../shared/log-archive";
import type { ContextLogLevel } from "../../../../../shared/log-event";
import { LOG_LEVEL_ORDER } from "../../../../../shared/log-event";
import { formatLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_OBSERVABILITY_URL } from "../../lib/cf-links";
import { errorCode, errorMessage, fireAndForget } from "../../lib/internal";
import { LEVEL_VARIANT } from "./log-level-variant";

interface ArchiveFeedProps {
    /** The shard to scope the archive read to (empty = the root shard). Threaded from the Logs panel's shard input. */
    readonly shardKey: string;
}

/** The fetch state machine — one page of the archive plus its loading/error status. */
interface ArchiveState {
    /** Cursor for the next page; `undefined` when there is none (last page or not loaded). */
    cursor: PipelineLogCursor | undefined;
    /** A genuine read failure to surface inline; `null` when none. */
    error: null | string;
    /** A read is in flight. */
    loading: boolean;
    /** The operator hasn't wired the archive — renders the "not configured" empty state, not an error. */
    notConfigured: boolean;
    /** The loaded rows, or `null` before the first page resolves. */
    rows: null | PipelineLogRow[];
}

/**
 * The transitions the fetch flow drives. `loaded` replaces the page (initial /
 * refetch); `append` adds the next page (Load more); `failed` clears rows (an
 * initial failure) while `pageFailed` keeps them (a Load-more failure).
 */
type ArchiveAction =
    | { cursor: PipelineLogCursor | undefined; rows: PipelineLogRow[]; type: "append" }
    | { cursor: PipelineLogCursor | undefined; rows: PipelineLogRow[]; type: "loaded" }
    | { message: string; type: "failed" }
    | { message: string; type: "pageFailed" }
    | { type: "loading" }
    | { type: "notConfigured" };

const INITIAL_STATE: ArchiveState = { cursor: undefined, error: null, loading: false, notConfigured: false, rows: null };

/** Fold one {@link ArchiveAction} into the {@link ArchiveState}; every transition is a single dispatched action. */
const archiveReducer = (state: ArchiveState, action: ArchiveAction): ArchiveState => {
    switch (action.type) {
        case "append": {
            return { ...state, cursor: action.cursor, error: null, loading: false, rows: [...(state.rows ?? []), ...action.rows] };
        }
        case "failed": {
            return { cursor: undefined, error: action.message, loading: false, notConfigured: false, rows: null };
        }
        case "loaded": {
            return { cursor: action.cursor, error: null, loading: false, notConfigured: false, rows: action.rows };
        }
        case "loading": {
            return { ...state, loading: true };
        }
        case "notConfigured": {
            return { cursor: undefined, error: null, loading: false, notConfigured: true, rows: null };
        }
        case "pageFailed": {
            return { ...state, error: action.message, loading: false };
        }
        default: {
            return state;
        }
    }
};

/** One archive row: time · level · path · message (+ fields) · trace · shard · user. */
const ArchiveRow = ({ row }: { readonly row: PipelineLogRow }): ReactElement => {
    const fields = formatLogFields(row.fields);

    return (
        <TableRow data-testid={`lg-archive-row-${String(row.ts)}`}>
            <TableCell className="tabular-nums whitespace-nowrap text-xs text-muted-foreground">{new Date(row.ts).toLocaleString()}</TableCell>
            <TableCell>
                <Badge variant={LEVEL_VARIANT[row.level]}>{row.level}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.functionPath}</TableCell>
            <TableCell className="max-w-md">
                <div className="truncate" title={row.message}>
                    {row.message}
                </div>
                {fields !== "" && (
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={fields}>
                        {fields}
                    </div>
                )}
            </TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.traceId ?? "—"}</TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.shardKey ?? "—"}</TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.userId ?? "—"}</TableCell>
        </TableRow>
    );
};

/**
 * The Logs panel's **Archive** feed: the durable `ctx.log` archive that
 * `pipelineLogSink` writes to R2 (an Iceberg table in R2 Data Catalog), read back
 * via the admin-gated `/_lunora/admin/logs/archive` route (the server holds the
 * R2 SQL credentials and runs the reader — the browser only sees decoded rows).
 *
 * Unlike the Requests/Errors feeds (bounded in-DO reads over a live WS), this is
 * an HTTP-only, keyset-paginated read with no live updates: it fetches one page,
 * and "Load more" appends the next (`nextCursor`). When the operator has wired no
 * archive (no table / no R2 SQL creds), the server returns
 * `LOG_ARCHIVE_NOT_CONFIGURED`, which renders as a "not configured" empty state
 * rather than an error.
 */
export const ArchiveFeed = ({ shardKey }: ArchiveFeedProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [pathPrefix, setPathPrefix] = useState<string>("");
    const [userIdFilter, setUserIdFilter] = useState<string>("");
    const [minLevel, setMinLevel] = useState<"" | ContextLogLevel>("");

    // The page + loading/error status move together, so they're one reducer rather
    // than five `useState`s kept in sync by hand (each fetch is a single dispatch).
    const [{ cursor, error, loading, notConfigured, rows }, dispatch] = useReducer(archiveReducer, INITIAL_STATE);

    const debouncedPathPrefix = useDebounced(pathPrefix.trim(), 400);
    const debouncedUserId = useDebounced(userIdFilter.trim(), 400);

    // The base filter (excluding the paging cursor). Built fresh each render; the
    // effect below keys off its serialization so an equal filter doesn't refetch.
    const baseQuery: PipelineLogQuery = {
        ...(debouncedPathPrefix === "" ? {} : { functionPathPrefix: debouncedPathPrefix }),
        ...(minLevel === "" ? {} : { minLevel }),
        ...(shardKey === "" ? {} : { shardKey }),
        ...(debouncedUserId === "" ? {} : { userId: debouncedUserId }),
    };
    const querySignature = JSON.stringify(baseQuery);

    // The filter generation currently on screen. `loadMore` captures the signature
    // it started under and drops its result if this ref has moved on — so a page-2
    // fetch that resolves after a filter change never appends stale rows / cursor
    // (the main fetch effect owns the reset). Kept in a ref so an in-flight
    // `loadMore` reads the latest value, not its stale closure.
    const activeSignatureRef = useRef(querySignature);

    useEffect(() => {
        const token = { cancelled: false };

        activeSignatureRef.current = querySignature;

        fireAndForget(
            (async (): Promise<void> => {
                dispatch({ type: "loading" });

                // `baseQuery` is the same value `querySignature` is derived from, so
                // keying the effect on the signature keeps this closure fresh. A
                // cancelled run dispatches nothing, leaving the newer effect to own state.
                try {
                    const page = await client.queryLogArchive(baseQuery);

                    if (!token.cancelled) {
                        dispatch({ cursor: page.nextCursor, rows: page.rows, type: "loaded" });
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        // A "not configured" failure is an empty state, not an error spew.
                        dispatch(
                            errorCode(error_) === LOG_ARCHIVE_NOT_CONFIGURED ? { type: "notConfigured" } : { message: errorMessage(error_), type: "failed" },
                        );
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
        // `baseQuery` is intentionally omitted — `querySignature` is its serialization
        // and the sole thing that should re-trigger a refetch (a new object identity
        // each render would loop).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, querySignature]);

    const loadMore = async (): Promise<void> => {
        if (cursor === undefined) {
            return;
        }

        // The filter this page-2 fetch belongs to; if it changes mid-flight, drop the result.
        const signature = querySignature;

        dispatch({ type: "loading" });

        try {
            const page = await client.queryLogArchive({ ...baseQuery, cursor });

            if (activeSignatureRef.current === signature) {
                dispatch({ cursor: page.nextCursor, rows: page.rows, type: "append" });
            }
        } catch (error_) {
            if (activeSignatureRef.current === signature) {
                dispatch({ message: errorMessage(error_), type: "pageFailed" });
            }
        }
    };

    const onPathPrefixChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setPathPrefix(event.target.value);
    };

    const onUserIdChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setUserIdFilter(event.target.value);
    };

    const onMinLevelChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        // The <select> only offers "" or a LOG_LEVEL_ORDER value.
        setMinLevel(event.target.value as "" | ContextLogLevel);
    };

    const onLoadMore = (): void => {
        fireAndForget(loadMore());
    };

    if (notConfigured) {
        return (
            <EmptyState
                action={
                    <a className="text-sm text-primary underline-offset-4 hover:underline" href={CLOUDFLARE_OBSERVABILITY_URL} rel="noreferrer" target="_blank">
                        {t("Open in Cloudflare")}
                    </a>
                }
                description={t(
                    "Wire pipelineLogSink to a Cloudflare Pipeline → R2 Data Catalog table and set R2_SQL_ACCOUNT_ID, R2_SQL_TOKEN, R2_SQL_BUCKET to browse the durable log archive here.",
                )}
                testId="lg-archive-not-configured"
                title={t("Log archive not configured")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="lg-archive">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Function path prefix")}
                    className="h-8 w-48"
                    data-testid="lg-archive-path"
                    onChange={onPathPrefixChange}
                    placeholder={t("function path…")}
                    value={pathPrefix}
                />
                <Input
                    aria-label={t("User id")}
                    className="h-8 w-40"
                    data-testid="lg-archive-user"
                    onChange={onUserIdChange}
                    placeholder={t("user id…")}
                    value={userIdFilter}
                />
                <select
                    aria-label={t("Minimum level")}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                    data-testid="lg-archive-min-level"
                    onChange={onMinLevelChange}
                    value={minLevel}
                >
                    <option value="">{t("min level")}</option>
                    {LOG_LEVEL_ORDER.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="lg-archive-error" role="alert">
                    {error}
                </p>
            )}

            {/* Initial fetch: no rows/error/cursor to render yet, so show a placeholder
                rather than a blank panel. (Paging keeps the existing rows on screen.) */}
            {loading && rows === null && error === null && (
                <p className="text-sm text-muted-foreground" data-testid="lg-archive-loading">
                    {t("Loading…")}
                </p>
            )}

            {rows !== null && rows.length === 0 && (
                <EmptyState
                    description={t("No archived logs match these filters. The durable archive fills as pipelineLogSink flushes records to R2.")}
                    testId="lg-archive-empty"
                    title={t("No archived logs.")}
                />
            )}

            {rows !== null && rows.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-border shadow-xs">
                    <Table data-testid="lg-archive-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Time")}</TableHead>
                                <TableHead>{t("Level")}</TableHead>
                                <TableHead>{t("Function")}</TableHead>
                                <TableHead>{t("Message")}</TableHead>
                                <TableHead>{t("Trace")}</TableHead>
                                <TableHead>{t("Shard")}</TableHead>
                                <TableHead>{t("User")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, index) => (
                                <ArchiveRow key={`${String(row.ts)}-${String(index)}`} row={row} />
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {cursor !== undefined && (
                <div>
                    <Button data-testid="lg-archive-more" disabled={loading} onClick={onLoadMore} size="sm" variant="outline">
                        {loading ? t("Loading…") : t("Load more")}
                    </Button>
                </div>
            )}
        </div>
    );
};

export type { ArchiveFeedProps };
