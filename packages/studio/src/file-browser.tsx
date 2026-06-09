import type { StorageObject } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { ConfirmButton } from "./confirm-button";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatBytes } from "./internal";

interface FileBrowserProps {
    /** Object-key prefix the browser filters by on first load. */
    readonly initialPrefix?: string;
    /** Objects requested per page. Forwarded to the storage `list` limit. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

/** Write text to the clipboard, guarded for the non-browser (test/SSR) path. */
const copyToClipboard = async (text: string): Promise<void> => {
    // The repo's browser-global pattern: reach globals via `globalThis` behind a
    // capability check so the module stays import-safe under Node/SSR.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only, guarded
    if ("navigator" in globalThis && "clipboard" in globalThis.navigator) {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only, guarded
        await globalThis.navigator.clipboard.writeText(text);
    }
};

interface FileRowProps {
    readonly busy: boolean;
    readonly copiedKey: null | string;
    readonly object: StorageObject;
    readonly onCopy: (key: string) => void;
    readonly onDelete: (key: string) => void;
    readonly t: TFunction;
}

/**
 * One object row. Extracted so each row binds its own copy/delete handlers via
 * `useCallback` rather than allocating a fresh closure per render in the parent
 * `.map(...)` (react-perf).
 */
const FileRow = ({ busy, copiedKey, object, onCopy, onDelete, t }: FileRowProps): ReactElement => {
    const copy = useCallback((): void => {
        onCopy(object.key);
    }, [onCopy, object.key]);

    const remove = useCallback((): void => {
        onDelete(object.key);
    }, [onDelete, object.key]);

    return (
        <TableRow data-testid="fb-row">
            <TableCell className="font-mono text-xs">{object.key}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{formatBytes(object.size)}</TableCell>
            <TableCell>{object.httpMetadata?.contentType ?? ""}</TableCell>
            <TableCell className="text-right">
                <span className="inline-flex items-center gap-1">
                    <Button data-testid={`storage-copy-${object.key}`} disabled={busy} onClick={copy} size="sm" type="button" variant="ghost">
                        {copiedKey === object.key ? t("Copied") : t("Copy URL")}
                    </Button>
                    <ConfirmButton confirmLabel={t("Delete object?")} disabled={busy} onConfirm={remove} testId={`storage-delete-${object.key}`}>
                        {t("Delete")}
                    </ConfirmButton>
                </span>
            </TableCell>
        </TableRow>
    );
};

/**
 * Browse — and mutate — objects in the storage (R2) bucket. Lists keys under an
 * optional prefix via the client's `listStorageObjects`, which hits the worker's
 * admin-gated `GET /_cirrus/admin/storage` endpoint — so the worker must be built
 * with a `storageList` function and `adminToken`. Paginates forward by cursor.
 *
 * Each row offers a "Copy URL" (signed/public URL via `signedStorageUrl`) and a
 * confirm-gated "Delete" (`deleteStorageObject`); the toolbar offers an upload
 * (`uploadStorageObject`) into the current prefix. Those write paths require the
 * worker to be built with `storageSignedUrl` / `storageDelete` / `storageUpload`
 * respectively — when absent, the worker responds with a clear `*_NOT_CONFIGURED`
 * error that surfaces inline rather than crashing the panel.
 */
export const FileBrowser = ({ initialPrefix, pageSize = DEFAULT_PAGE_SIZE }: FileBrowserProps): ReactElement => {
    const t = useT();
    const client = useCirrus();

    const [prefix, setPrefix] = useState<string>(initialPrefix ?? "");
    const [objects, setObjects] = useState<StorageObject[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [copiedKey, setCopiedKey] = useState<null | string>(null);
    // Cursor stack so "Next" walks forward and we can show whether more remain.
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const fileInputRef = useRef<HTMLInputElement>(null);

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

    const onCopy = useCallback(
        (key: string): void => {
            setError(null);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const url = await client.signedStorageUrl(key);

                        await copyToClipboard(url);
                        setCopiedKey(key);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    }
                })(),
            );
        },
        [client],
    );

    const onDelete = useCallback(
        (key: string): void => {
            setError(null);
            setBusy(true);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        await client.deleteStorageObject(key);
                        await list(prefix, undefined, false);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    } finally {
                        setBusy(false);
                    }
                })(),
            );
        },
        [client, list, prefix],
    );

    const onUploadClick = useCallback((): void => {
        fileInputRef.current?.click();
    }, []);

    const onFileChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            const input = event.target;
            const file = input.files?.[0];

            // Reset the input so picking the same file again re-fires `change`.
            input.value = "";

            if (!file) {
                return;
            }

            // Scope the upload key under the active prefix so it lands where the
            // operator is browsing.
            const key = `${prefix}${file.name}`;

            setError(null);
            setBusy(true);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const body = await file.arrayBuffer();

                        await client.uploadStorageObject({ body, contentType: file.type === "" ? undefined : file.type, key });
                        await list(prefix, undefined, false);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    } finally {
                        setBusy(false);
                    }
                })(),
            );
        },
        [client, list, prefix],
    );

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
                <Button data-testid="storage-upload" disabled={busy} onClick={onUploadClick} size="sm" type="button" variant="outline">
                    {busy ? t("Uploading…") : t("Upload")}
                </Button>
                <input className="hidden" data-testid="storage-file-input" onChange={onFileChange} ref={fileInputRef} type="file" />
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="storage-error" role="alert">
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
                                <TableHead aria-label={t("Actions")} />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {objects.map((object) => (
                                <FileRow busy={busy} copiedKey={copiedKey} key={object.key} object={object} onCopy={onCopy} onDelete={onDelete} t={t} />
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
