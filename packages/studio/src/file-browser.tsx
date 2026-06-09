import type { StorageObject } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatBytes } from "./internal";

interface FileBrowserProps {
    /** Object-key prefix the browser filters by on first load. */
    readonly initialPrefix?: string;
    /** Objects requested per page. Forwarded to the storage `list` limit. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Browse objects in the storage (R2) bucket. Lists keys under an optional prefix
 * via the client's `listStorageObjects`, which hits the worker's admin-gated
 * `GET /_cirrus/admin/storage` endpoint — so the worker must be built with a
 * `storageList` function and `adminToken`. Paginates forward by cursor.
 *
 * Read-only: surfaces key, size and content-type. Uploads/deletes are out of
 * scope; the host's own storage API owns mutations.
 */
export const FileBrowser = ({ initialPrefix, pageSize = DEFAULT_PAGE_SIZE }: FileBrowserProps): ReactElement => {
    const t = useT();
    const client = useCirrus();

    const [prefix, setPrefix] = useState<string>(initialPrefix ?? "");
    const [objects, setObjects] = useState<StorageObject[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);
    // Cursor stack so "Next" walks forward and we can show whether more remain.
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

    const list = useCallback(
        async (searchPrefix: string, cursor: string | undefined, append: boolean): Promise<void> => {
            setError(null);
            setBusy(true);

            try {
                const page = await client.listStorageObjects({ cursor, limit: pageSize, prefix: searchPrefix });

                setObjects((previous) => (append && previous !== null ? [...previous, ...page.objects] : page.objects));
                setNextCursor(page.cursor);
            } catch (error_) {
                if (!append) {
                    setObjects(null);
                }

                setError(errorMessage(error_));
            } finally {
                setBusy(false);
            }
        },
        [client, pageSize],
    );

    useEffect(() => {
        fireAndForget(list(initialPrefix ?? "", undefined, false));
    }, [list, initialPrefix]);

    const onPrefixChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setPrefix(event.target.value);
    }, []);

    const listFirst = useCallback((): void => {
        fireAndForget(list(prefix, undefined, false));
    }, [list, prefix]);

    const loadMore = useCallback((): void => {
        fireAndForget(list(prefix, nextCursor, true));
    }, [list, prefix, nextCursor]);

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-file-browser">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Key prefix")}
                    className="h-8 w-64 max-w-full"
                    data-testid="fb-prefix-input"
                    onChange={onPrefixChange}
                    placeholder={t("key prefix (optional)")}
                    value={prefix}
                />
                <Button data-testid="fb-list" disabled={busy} onClick={listFirst} size="sm" type="button">
                    {t("List")}
                </Button>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="fb-error" role="alert">
                    {error}
                </p>
            )}

            {objects !== null && objects.length === 0 && (
                <EmptyState
                    description={t("Objects you upload to your R2 buckets will appear here.")}
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
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                            <path d="M12 11v5m-2.5-2.5h5" />
                        </svg>
                    }
                    testId="fb-empty"
                    title={t("No objects.")}
                />
            )}

            {objects !== null && objects.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="fb-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("key")}</TableHead>
                                <TableHead>{t("size")}</TableHead>
                                <TableHead>{t("content-type")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {objects.map((object) => (
                                <TableRow data-testid="fb-row" key={object.key}>
                                    <TableCell className="font-mono text-xs">{object.key}</TableCell>
                                    <TableCell className="tabular-nums text-muted-foreground">{formatBytes(object.size)}</TableCell>
                                    <TableCell>{object.httpMetadata?.contentType ?? ""}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {nextCursor !== undefined && (
                <div>
                    <Button data-testid="fb-next" disabled={busy} onClick={loadMore} size="sm" type="button" variant="outline">
                        {t("Load more")}
                    </Button>
                </div>
            )}
        </div>
    );
};

export type { FileBrowserProps };
