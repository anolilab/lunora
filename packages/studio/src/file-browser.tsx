import type { StorageObject } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { ConfirmButton } from "./confirm-button";
import { FileGallery } from "./file-gallery";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget, formatBytes } from "./internal";

/** How the file list is laid out. */
type FileView = "grid" | "list";

/**
 * The comparable value for an object under a sort key — `size`, `type`, `date`,
 * `name`, or `tag:NAME` for a user-supplied customMetadata tag. Numbers for
 * size/date sort numerically; everything else compares as a locale string.
 */
// eslint-disable-next-line sonarjs/function-return-type -- numeric keys (size/date) sort numerically, the rest as strings; one comparator handles both
const fileSortValue = (object: StorageObject, key: string): number | string => {
    if (key === "size") {
        return object.size;
    }

    if (key === "type") {
        return object.httpMetadata?.contentType ?? "";
    }

    if (key === "date") {
        // R2 sends an ISO string, a mock may send epoch ms — `new Date` handles both.
        return object.uploaded === undefined ? 0 : new Date(object.uploaded).getTime();
    }

    if (key.startsWith("tag:")) {
        return object.customMetadata?.[key.slice(4)] ?? "";
    }

    return object.key;
};

/** Sort a copy of the files by the chosen metadata key + direction (numeric or locale-aware). */
const sortFiles = (files: ReadonlyArray<StorageObject>, key: string, direction: "asc" | "desc"): StorageObject[] => {
    const factor = direction === "desc" ? -1 : 1;

    return files.toSorted((a, b) => {
        const av = fileSortValue(a, key);
        const bv = fileSortValue(b, key);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));

        return cmp * factor;
    });
};

/**
 * Split a flat object listing into the immediate folders and files at `prefix` —
 * R2-Explorer-style navigation derived client-side (the list is recursive, so a
 * key's first remaining `/`-segment is a sub-folder; a remainder with no slash is
 * a file at this level). Folders are de-duped and sorted; files keep list order.
 * Note: this reflects only the rows loaded so far — paginate (Load more) to surface
 * folders whose first key is further down the listing.
 */
const deriveEntries = (objects: ReadonlyArray<StorageObject>, prefix: string): { files: StorageObject[]; folders: string[] } => {
    const folders = new Set<string>();
    const files: StorageObject[] = [];

    for (const object of objects) {
        const rest = object.key.slice(prefix.length);
        const slash = rest.indexOf("/");

        if (slash === -1) {
            files.push(object);
        } else {
            folders.add(rest.slice(0, slash + 1));
        }
    }

    return { files, folders: [...folders].toSorted((a, b) => a.localeCompare(b)) };
};

interface BreadcrumbsProps {
    readonly onNavigate: (prefix: string) => void;
    readonly prefix: string;
    readonly t: TFunction;
}

/** One breadcrumb segment — extracted so each binds its own navigate target. */
const Crumb = ({ label, onNavigate, target }: { readonly label: string; readonly onNavigate: (prefix: string) => void; readonly target: string }): ReactElement => {
    const go = useCallback((): void => {
        onNavigate(target);
    }, [onNavigate, target]);

    return (
        <button className="rounded px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" onClick={go} type="button">
            {label}
        </button>
    );
};

/**
 * The folder path as clickable breadcrumbs — a root crumb plus one per `/`-segment
 * of the current prefix, each navigating back up to that level.
 */
const Breadcrumbs = ({ onNavigate, prefix, t }: BreadcrumbsProps): ReactElement => {
    const segments = prefix.split("/").filter((segment) => segment !== "");

    return (
        <nav aria-label={t("Folder path")} className="flex flex-wrap items-center gap-0.5 text-xs" data-testid="fb-breadcrumbs">
            <Crumb label={t("root")} onNavigate={onNavigate} target="" />
            {segments.map((segment, index) => (
                <span className="flex items-center gap-0.5" key={`${segment}-${index.toString()}`}>
                    <span className="text-muted-foreground/50">/</span>
                    <Crumb label={segment} onNavigate={onNavigate} target={`${segments.slice(0, index + 1).join("/")}/`} />
                </span>
            ))}
        </nav>
    );
};

interface FolderRowProps {
    readonly name: string;
    readonly onEnter: (name: string) => void;
}

/** One folder row — a folder glyph + name; clicking descends into it. */
const FolderRow = ({ name, onEnter }: FolderRowProps): ReactElement => {
    const enter = useCallback((): void => {
        onEnter(name);
    }, [name, onEnter]);

    return (
        <TableRow>
            <TableCell colSpan={4}>
                <button className="inline-flex items-center gap-2 font-mono text-xs outline-none hover:text-foreground focus-visible:text-foreground" data-testid="fb-folder" onClick={enter} type="button">
                    <svg aria-hidden="true" className="size-4 text-muted-foreground" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                    </svg>
                    {name}
                </button>
            </TableCell>
        </TableRow>
    );
};

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
    /** Current folder prefix, stripped from the displayed name (the full key still drives actions). */
    readonly prefix: string;
    readonly t: TFunction;
}

/**
 * One object row. Extracted so each row binds its own copy/delete handlers via
 * `useCallback` rather than allocating a fresh closure per render in the parent
 * `.map(...)` (react-perf). Shows the name relative to the current folder; the
 * full key still scopes the action testids and the copy/delete calls.
 */
const FileRow = ({ busy, copiedKey, object, onCopy, onDelete, prefix, t }: FileRowProps): ReactElement => {
    const copy = useCallback((): void => {
        onCopy(object.key);
    }, [onCopy, object.key]);

    const remove = useCallback((): void => {
        onDelete(object.key);
    }, [onDelete, object.key]);

    return (
        <TableRow data-testid="fb-row">
            <TableCell className="font-mono text-xs">{object.key.slice(prefix.length)}</TableCell>
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
    // Share-link lifetime (seconds) applied by the per-row "Copy URL" action.
    const [expiry, setExpiry] = useState<number>(3600);
    // List vs. thumbnail grid; the grid's tile size is resized live by the slider.
    const [view, setView] = useState<FileView>("list");
    const [thumbSize, setThumbSize] = useState<number>(128);
    // Client-side sort over the loaded page.
    const [sortKey, setSortKey] = useState<string>("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
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

    // Navigate to a folder prefix (breadcrumb or folder row) and reload from its
    // first page.
    const navigate = useCallback(
        (target: string): void => {
            setPrefix(target);
            fireAndForget(list(target, undefined, false));
        },
        [list],
    );

    const enterFolder = useCallback(
        (name: string): void => {
            navigate(`${prefix}${name}`);
        },
        [navigate, prefix],
    );

    // Split the loaded keys into the immediate folders + files at this prefix.
    const { files, folders } = useMemo(() => deriveEntries(objects ?? [], prefix), [objects, prefix]);

    // The customMetadata tag keys present across the loaded files — surfaced as
    // extra sort options ("user-supplied tags").
    const tagKeys = useMemo<string[]>(() => {
        const keys = new Set<string>();

        for (const file of files) {
            for (const key of Object.keys(file.customMetadata ?? {})) {
                keys.add(key);
            }
        }

        return [...keys].toSorted((a, b) => a.localeCompare(b));
    }, [files]);

    const sortedFiles = useMemo(() => sortFiles(files, sortKey, sortDirection), [files, sortKey, sortDirection]);

    // Resolve a viewable (signed) URL for a thumbnail, at the toolbar's expiry.
    const resolveUrl = useCallback((key: string): Promise<string> => client.signedStorageUrl(key, expiry), [client, expiry]);

    const showList = useCallback((): void => {
        setView("list");
    }, []);

    const showGrid = useCallback((): void => {
        setView("grid");
    }, []);

    const onSortKeyChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setSortKey(event.target.value);
    }, []);

    const toggleSortDirection = useCallback((): void => {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    }, []);

    const onThumbSizeChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setThumbSize(Number.parseInt(event.target.value, 10));
    }, []);

    const onExpiryChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setExpiry(Number.parseInt(event.target.value, 10));
    }, []);

    const onCopy = useCallback(
        (key: string): void => {
            setError(null);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const url = await client.signedStorageUrl(key, expiry);

                        await copyToClipboard(url);
                        setCopiedKey(key);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    }
                })(),
            );
        },
        [client, expiry],
    );

    // Clear the "Copied" indicator a couple of seconds after a copy, so it reads as
    // transient feedback rather than a sticky per-row state.
    useEffect(() => {
        if (copiedKey === null) {
            return undefined;
        }

        const timer = globalThis.setTimeout(() => {
            setCopiedKey(null);
        }, 2000);

        return () => {
            globalThis.clearTimeout(timer);
        };
    }, [copiedKey]);

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
                <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground" htmlFor="storage-expiry">
                    {t("Link expiry")}
                    <select
                        className="h-8 rounded-md border border-border bg-background px-1 tabular-nums outline-none focus-visible:border-ring"
                        data-testid="storage-expiry"
                        id="storage-expiry"
                        onChange={onExpiryChange}
                        value={expiry}
                    >
                        <option value={900}>{t("15m")}</option>
                        <option value={3600}>{t("1h")}</option>
                        <option value={86_400}>{t("24h")}</option>
                        <option value={604_800}>{t("7d")}</option>
                    </select>
                </label>
            </div>

            {objects !== null && <Breadcrumbs onNavigate={navigate} prefix={prefix} t={t} />}

            {objects !== null && objects.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="fb-controls">
                    <div className="inline-flex overflow-hidden rounded-md border border-border">
                        <button
                            aria-pressed={view === "list"}
                            className="px-2 py-1 outline-none transition-colors hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            data-testid="fb-view-list"
                            onClick={showList}
                            type="button"
                        >
                            {t("List")}
                        </button>
                        <button
                            aria-pressed={view === "grid"}
                            className="border-s border-border px-2 py-1 outline-none transition-colors hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            data-testid="fb-view-grid"
                            onClick={showGrid}
                            type="button"
                        >
                            {t("Grid")}
                        </button>
                    </div>

                    <label className="flex items-center gap-1.5 text-muted-foreground" htmlFor="fb-sort">
                        {t("Sort")}
                        <select
                            className="h-8 rounded-md border border-border bg-background px-1 outline-none focus-visible:border-ring"
                            data-testid="fb-sort"
                            id="fb-sort"
                            onChange={onSortKeyChange}
                            value={sortKey}
                        >
                            <option value="name">{t("Name")}</option>
                            <option value="size">{t("size")}</option>
                            <option value="type">{t("Type")}</option>
                            <option value="date">{t("Modified")}</option>
                            {tagKeys.map((key) => (
                                <option key={key} value={`tag:${key}`}>
                                    {key}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        aria-label={t("Toggle sort direction")}
                        className="flex size-8 items-center justify-center rounded-md border border-border tabular-nums outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        data-testid="fb-sort-dir"
                        onClick={toggleSortDirection}
                        type="button"
                    >
                        {sortDirection === "asc" ? "↑" : "↓"}
                    </button>

                    {view === "grid" && (
                        <label className="ml-auto flex items-center gap-1.5 text-muted-foreground" htmlFor="fb-thumb-size">
                            {t("Thumbnail size")}
                            <input
                                className="accent-primary"
                                data-testid="fb-thumb-size"
                                id="fb-thumb-size"
                                max={240}
                                min={80}
                                onChange={onThumbSizeChange}
                                step={8}
                                type="range"
                                value={thumbSize}
                            />
                        </label>
                    )}
                </div>
            )}

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

            {objects !== null && objects.length > 0 && view === "list" && (
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
                            {folders.map((folder) => (
                                <FolderRow key={folder} name={folder} onEnter={enterFolder} />
                            ))}
                            {sortedFiles.map((object) => (
                                <FileRow busy={busy} copiedKey={copiedKey} key={object.key} object={object} onCopy={onCopy} onDelete={onDelete} prefix={prefix} t={t} />
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {objects !== null && objects.length > 0 && view === "grid" && (
                <FileGallery
                    busy={busy}
                    copiedKey={copiedKey}
                    files={sortedFiles}
                    folders={folders}
                    onCopy={onCopy}
                    onDelete={onDelete}
                    onEnterFolder={enterFolder}
                    prefix={prefix}
                    resolveUrl={resolveUrl}
                    size={thumbSize}
                    t={t}
                />
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
