import type { VectorIndexSummary, VectorQueryMatch } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell } from "../../lib/internal";

interface VectorBrowserProps {
    /**
     * Load the schema's vector indexes. Defaults to `client.listVectorIndexes`,
     * which hits the worker's admin-gated `/_lunora/admin/vector/indexes`
     * endpoint — so the panel works out of the box under `&lt;LunoraProvider>`,
     * provided the worker is built with a `vectorIntrospector` and `adminToken`.
     */
    readonly loadIndexes?: () => Promise<VectorIndexSummary[]>;

    /**
     * Run a similarity query. Defaults to `client.queryVectorIndex`. Throws
     * `VECTOR_QUERY_UNSUPPORTED` when the worker wired no embedder — surfaced as
     * an inline error so the operator learns the index is browse-only.
     */
    readonly runQuery?: (options: { name: string; text: string; topK?: number }) => Promise<VectorQueryMatch[]>;
}

/** Default neighbours requested by the studio's similarity search. */
const DEFAULT_TOP_K = 10;

/** One detail cell: a muted em dash for an absent value, the formatted value otherwise. */
const Detail = ({ label, value }: { readonly label: string; readonly value: number | string | undefined }): ReactElement => (
    <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-sm">{value ?? "—"}</span>
    </div>
);

/**
 * Read-only **vector index browser**. Lists every Vectorize index the schema
 * declares (via the generated `LUNORA_VECTOR_INDEXES` registry — Vectorize can't
 * enumerate indexes at runtime), each merged with live `describe()` stats
 * (vector count, processing watermark) when the binding is reachable. Selecting
 * an index shows its declared shape and offers a similarity search: the worker
 * embeds the query text with the index's embedder and returns the nearest
 * matches. An index with no embedder lists read-only — the search reports it.
 */

export const VectorBrowser = ({ loadIndexes, runQuery }: VectorBrowserProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [indexes, setIndexes] = useState<VectorIndexSummary[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [selected, setSelected] = useState<null | string>(null);

    const [queryText, setQueryText] = useState<string>("");
    const [matches, setMatches] = useState<VectorQueryMatch[] | null>(null);
    const [queryError, setQueryError] = useState<null | string>(null);
    const [searching, setSearching] = useState<boolean>(false);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await (loadIndexes ?? (() => client.listVectorIndexes()))();

                    if (!token.cancelled) {
                        setIndexes(result);
                        setError(null);
                        setSelected((current) => current ?? result[0]?.name ?? null);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setIndexes(null);
                        setError(errorMessage(error_));
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, loadIndexes]);

    const selectedIndex = indexes?.find((index) => index.name === selected) ?? null;

    const onSelect = (event: React.MouseEvent<HTMLTableRowElement>): void => {
        setSelected(event.currentTarget.dataset.index ?? null);
        setMatches(null);
        setQueryError(null);
    };

    const onQueryTextChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setQueryText(event.target.value);
    };

    const search = async (): Promise<void> => {
        const text = queryText.trim();

        if (selected === null || text === "") {
            return;
        }

        setSearching(true);
        setQueryError(null);

        try {
            const result = await (runQuery ?? ((options: { name: string; text: string; topK?: number }) => client.queryVectorIndex(options)))({
                name: selected,
                text,
                topK: DEFAULT_TOP_K,
            });

            setMatches(result);
        } catch (error_) {
            setMatches(null);
            setQueryError(errorMessage(error_));
        }

        setSearching(false);
    };

    const onSearch = (): void => {
        fireAndForget(search());
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-vector-browser">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="vector-error" role="alert">
                    {error}
                </p>
            )}

            {indexes !== null && indexes.length === 0 && (
                <EmptyState
                    description={t("Indexes declared with .vectorize() or defineVectorIndex() appear here.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 7l8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 17l8 4 8-4" />
                        </svg>
                    }
                    testId="vector-empty"
                    title={t("No vector indexes.")}
                />
            )}

            {indexes !== null && indexes.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="vector-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("name")}</TableHead>
                                    <TableHead>{t("table")}</TableHead>
                                    <TableHead>{t("dimensions")}</TableHead>
                                    <TableHead>{t("metric")}</TableHead>
                                    <TableHead>{t("vectors")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {indexes.map((index) => (
                                    <TableRow
                                        className={index.name === selected ? "border-l-2 border-l-royal-amethyst bg-muted/50" : "cursor-pointer"}
                                        data-index={index.name}
                                        data-testid={`vector-row-${index.name}`}
                                        key={index.name}
                                        onClick={onSelect}
                                    >
                                        <TableCell className="font-mono text-xs">{index.name}</TableCell>
                                        <TableCell className="font-mono text-xs">{index.table}</TableCell>
                                        <TableCell className="tabular-nums">{index.dimensions ?? "—"}</TableCell>
                                        <TableCell>{index.metric ?? "—"}</TableCell>
                                        <TableCell className="tabular-nums">{index.vectorsCount ?? "—"}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {selectedIndex !== null && (
                <section className="border border-border bg-card p-3" data-testid="vector-detail">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Detail label={t("field")} value={selectedIndex.field} />
                        <Detail label={t("dimensions")} value={selectedIndex.dimensions} />
                        <Detail label={t("metric")} value={selectedIndex.metric} />
                        <Detail label={t("vectors")} value={selectedIndex.vectorsCount} />
                    </div>

                    {selectedIndex.metadata !== undefined && selectedIndex.metadata.length > 0 && (
                        <p className="mt-3 text-xs text-muted-foreground" data-testid="vector-metadata">
                            {t("metadata")}: <span className="font-mono">{selectedIndex.metadata.join(", ")}</span>
                        </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Input
                            className="min-w-[18rem] flex-1"
                            data-testid="vector-query-input"
                            onChange={onQueryTextChange}
                            placeholder={t("Search by similarity…")}
                            value={queryText}
                        />
                        <Button data-testid="vector-search" disabled={searching || queryText.trim() === ""} onClick={onSearch}>
                            {searching ? t("Searching…") : t("Search")}
                        </Button>
                    </div>

                    {queryError !== null && (
                        <p className="mt-2 text-sm text-destructive" data-testid="vector-query-error" role="alert">
                            {queryError}
                        </p>
                    )}

                    {matches !== null && matches.length === 0 && (
                        <p className="mt-2 text-sm text-muted-foreground" data-testid="vector-no-matches">
                            {t("No matches.")}
                        </p>
                    )}

                    {matches !== null && matches.length > 0 && (
                        <Card className="mt-3 overflow-hidden py-0">
                            <CardContent className="px-0">
                                <Table data-testid="vector-matches">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("id")}</TableHead>
                                            <TableHead>{t("score")}</TableHead>
                                            <TableHead>{t("metadata")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {matches.map((match) => (
                                            <TableRow data-testid={`vector-match-${match.id}`} key={match.id}>
                                                <TableCell className="font-mono text-xs">{match.id}</TableCell>
                                                <TableCell className="tabular-nums">{match.score.toFixed(4)}</TableCell>
                                                <TableCell className="max-w-md truncate font-mono text-xs">
                                                    {match.metadata === undefined ? "—" : formatCell(match.metadata)}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    )}
                </section>
            )}
        </div>
    );
};

export type { VectorBrowserProps };
