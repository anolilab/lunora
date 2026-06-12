import type { StorageObject } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAutoRefresh } from "../../../hooks/use-auto-refresh";
import type { DanglingReference, DanglingReferenceResult, StorageReference, StorageReferenceResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../../lib/internal";
import type { KeySelection } from "../../data/hooks/use-key-selection";
import { useKeySelection } from "../../data/hooks/use-key-selection";
import { DEFAULT_SHARE_LIFETIME, deriveEntries, sortFiles } from "../storage-entries";

const STORAGE_REFERENCES = adminRef(ADMIN_FUNCTIONS.storageReferences);
const STORAGE_ORPHANS = adminRef(ADMIN_FUNCTIONS.storageOrphans);

/**
 * Hard cap on the number of bucket object keys the orphan check enumerates in one
 * pass. The dangling-reference scan needs the bucket's LIVE keys to decide which
 * record references point at a missing object, but a huge bucket can't be walked
 * unboundedly from the browser. Past this many keys the check stops paging; the
 * server still bounds its own scan and the studio surfaces the result as partial.
 */
const ORPHAN_LIVE_KEY_CAP = 10_000;

/** Objects requested per page while enumerating the bucket for the orphan check. */
const ORPHAN_LIST_PAGE_SIZE = 1000;

/** How the file list is laid out. */
type FileView = "grid" | "list";

/**
 * The fixed lifetime (seconds) of the URL the gallery resolves for a thumbnail.
 * Decoupled from the per-row Copy-URL `expiry` so changing the "Link expiry"
 * dropdown never re-fetches every thumbnail.
 */
const THUMBNAIL_URL_TTL = 3600;

/** The flat view-model the {@link useFileBrowser} controller hands to the panel. */
interface FileBrowserModel {
    readonly allSelected: boolean;
    readonly bulkDelete: () => void;
    readonly busy: boolean;
    /** Enumerate the bucket and resolve the dangling references (records pointing at missing objects) on `referenceShard`. */
    readonly checkOrphans: () => void;
    readonly clearSelection: () => void;
    readonly copiedKey: string | undefined;
    /** `true` while the orphan check is enumerating the bucket / resolving dangling references. */
    readonly danglingBusy: boolean;
    /** Record `v.storage()` fields whose value points at an object the bucket no longer has; `undefined` until the check is run. */
    readonly danglingReferences: ReadonlyArray<DanglingReference> | undefined;
    /** `true` when the orphan check's scan was clipped by a bound — the dangling list is partial. */
    readonly danglingTruncated: boolean;
    /** The draft prefix bound to the input — applied to the listing only on List/navigate. */
    readonly draftPrefix: string;
    readonly enterFolder: (name: string) => void;
    readonly error: string | undefined;
    readonly expiry: number;
    readonly files: ReadonlyArray<StorageObject>;
    readonly folders: ReadonlyArray<string>;
    /** Whether the loaded listing has any objects (drives empty-state vs. controls). */
    readonly hasObjects: boolean;

    /**
     * Whether the schema declares any `v.storage()` columns — i.e. the app models
     * records↔files joins at all. Drives whether the "Used by" / orphan UI shows
     * (an app with no storage columns never sees a misleading "Orphan" badge).
     */
    readonly hasStorageColumns: boolean;
    readonly listFirst: () => void;
    /** Whether any rows have loaded (drives the breadcrumbs / empty-state gating). */
    readonly loaded: boolean;
    readonly loadMore: () => void;
    readonly navigate: (target: string) => void;
    readonly nextCursor: string | undefined;
    readonly onCopy: (key: string) => void;
    readonly onDelete: (key: string) => void;
    readonly onDownload: (key: string) => void;
    readonly onExpiryChange: (seconds: number) => void;
    readonly onFile: (file: File) => void;
    readonly onSortKeyChange: (key: string) => void;
    readonly onThumbSizeChange: (size: number) => void;
    /** The currently-loaded prefix used to slice names + derive folders. */
    readonly prefix: string;
    /** Rows that reference each loaded object key (via a `v.storage()` column); empty array = orphan on this shard. */
    readonly references: Readonly<Record<string, ReadonlyArray<StorageReference>>>;
    /** The shard whose `v.storage()` columns are scanned for references; empty = root shard. */
    readonly referenceShard: string;
    /** Resolve a thumbnail URL at a fixed TTL (independent of `expiry`). */
    readonly resolveUrl: (key: string) => Promise<string>;
    readonly selected: ReadonlySet<string>;
    readonly setDraftPrefix: (prefix: string) => void;
    readonly setReferenceShard: (shard: string) => void;
    readonly showGrid: () => void;
    readonly showList: () => void;
    readonly someSelected: boolean;
    readonly sortDirection: "asc" | "desc";
    readonly sortKey: string;
    readonly tagKeys: ReadonlyArray<string>;
    readonly thumbSize: number;
    readonly toggleSelect: (key: string) => void;
    readonly toggleSelectAll: () => void;
    readonly toggleSortDirection: () => void;
    readonly view: FileView;
}

interface UseFileBrowserOptions {
    readonly initialPrefix?: string;
    readonly pageSize: number;
}

/**
 * Trigger a browser download of `url` named `filename`. No-op outside the browser
 * (SSR / tests). Clicks a transient anchor with the `download` attribute set —
 * mirrors `grid-features`' `downloadFile`. For a cross-origin signed URL the
 * `download` attribute is advisory (the browser may navigate/open instead of
 * saving), which is the acceptable fallback for a presigned object URL.
 */
const triggerDownload = (url: string, filename: string): void => {
    if (!("document" in globalThis)) {
        return;
    }

    const anchor = globalThis.document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    globalThis.document.body.append(anchor);
    anchor.click();
    anchor.remove();
};

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

/**
 * The file browser's controller: owns all listing/pagination, prefix +
 * folder-navigation, sort, view + thumbnail-size, share-link expiry, selection +
 * bulk delete, copy, delete and upload state, and composes {@link useKeySelection}.
 * Returns a flat {@link FileBrowserModel} so the panel + toolbar + list/gallery
 * stay presentational.
 */
const useFileBrowser = ({ initialPrefix, pageSize }: UseFileBrowserOptions): FileBrowserModel => {
    const client = useCirrus();

    // The loaded prefix (drives deriveEntries + name-slicing) vs. the draft the
    // input edits live — kept apart so typing never garbles the loaded rows.
    const [prefix, setPrefix] = useState<string>(initialPrefix ?? "");
    const [draftPrefix, setDraftPrefix] = useState<string>(initialPrefix ?? "");
    // Share-link lifetime (seconds) applied by the per-row "Copy URL" action.
    const [expiry, setExpiry] = useState<number>(DEFAULT_SHARE_LIFETIME);
    // List vs. thumbnail grid; the grid's tile size is resized live by the slider.
    const [view, setView] = useState<FileView>("list");
    const [thumbSize, setThumbSize] = useState<number>(128);
    // Client-side sort over the loaded page.
    const [sortKey, setSortKey] = useState<string>("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    const [objects, setObjects] = useState<StorageObject[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState<boolean>(false);
    const [copiedKey, setCopiedKey] = useState<string | undefined>(undefined);
    // Cursor stack so "Next" walks forward and we can show whether more remain.
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    // The records↔files join (PLAN3 §1.3): which rows reference each loaded object
    // key, scanned on `referenceShard` (empty = root shard, the default topology).
    const [referenceShard, setReferenceShard] = useState<string>("");
    const [references, setReferences] = useState<Record<string, StorageReference[]>>({});
    const [hasStorageColumns, setHasStorageColumns] = useState<boolean>(false);
    // The inverse join (dangling references): record `v.storage()` fields pointing
    // at an object the bucket no longer has. `undefined` until the operator runs
    // the explicit check (it walks the whole bucket, so it isn't run on every load).
    const [danglingReferences, setDanglingReferences] = useState<DanglingReference[] | undefined>(undefined);
    const [danglingBusy, setDanglingBusy] = useState<boolean>(false);
    const [danglingTruncated, setDanglingTruncated] = useState<boolean>(false);

    const list = useCallback(
        async (searchPrefix: string, cursor: string | undefined, append: boolean): Promise<void> => {
            setError(undefined);
            setBusy(true);

            try {
                const page = await client.listStorageObjects({ cursor, limit: pageSize, prefix: searchPrefix });

                setObjects((previous) => (append && previous !== undefined ? [...previous, ...page.objects] : page.objects));
                setNextCursor(page.cursor);
            } catch (error_) {
                if (!append) {
                    setObjects(undefined);
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

    // R2 is HTTP-only (no subscription channel), so poll the current prefix's
    // first page to surface new uploads / deletions (including from other clients)
    // without a manual reload — but only while the operator hasn't paged past the
    // first page, so a background tick never collapses an expanded listing.
    // `useAutoRefresh` pauses while the tab is hidden.
    const onFirstPage = (objects?.length ?? 0) <= pageSize;

    useAutoRefresh(() => {
        fireAndForget(list(prefix, undefined, false));
    }, onFirstPage);

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

    // A re-sort-stable signature of the loaded object keys, so toggling the sort
    // order never re-fetches the (order-independent) reference index.
    const keysSignature = useMemo(() => [...new Set(sortedFiles.map((file) => file.key))].toSorted((a, b) => a.localeCompare(b)).join("\n"), [sortedFiles]);

    // Resolve the records↔files join for the loaded keys against `referenceShard`.
    // Best-effort: a worker that predates the feature (or a closed admin gate)
    // throws, which we treat as "no storage columns" so the file browser degrades
    // to its plain listing instead of surfacing an error.
    useEffect(() => {
        const keys = keysSignature === "" ? [] : keysSignature.split("\n");

        if (keys.length === 0) {
            setReferences({});

            return undefined;
        }

        // A mutable flag (not a narrowed `let`) so the async closure's checks read
        // the latest value after the cleanup runs on unmount / dep change.
        const live = { current: true };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = (await client.query(STORAGE_REFERENCES, { keys }, callOptions(referenceShard))) as Partial<StorageReferenceResult>;

                    if (live.current) {
                        setReferences(result.references ?? {});
                        setHasStorageColumns(Object.keys(result.storageColumns ?? {}).length > 0);
                    }
                } catch {
                    if (live.current) {
                        setReferences({});
                        setHasStorageColumns(false);
                    }
                }
            })(),
        );

        return () => {
            live.current = false;
        };
    }, [client, keysSignature, referenceShard]);

    const keyOf = useCallback((object: StorageObject): string => object.key, []);
    const {
        allSelected,
        clear: clearSelection,
        selected,
        someSelected,
        toggle: toggleSelect,
        toggleAll: toggleSelectAll,
    }: KeySelection = useKeySelection(sortedFiles, keyOf);

    const listFirst = useCallback((): void => {
        setPrefix(draftPrefix);
        fireAndForget(list(draftPrefix, undefined, false));
    }, [draftPrefix, list]);

    const loadMore = useCallback((): void => {
        fireAndForget(list(prefix, nextCursor, true));
    }, [list, prefix, nextCursor]);

    // Navigate to a folder prefix (breadcrumb or folder row) and reload from its
    // first page. Both the loaded + draft prefix track the new target, and the
    // selection resets (the loaded rows change underneath it).
    const navigate = useCallback(
        (target: string): void => {
            setPrefix(target);
            setDraftPrefix(target);
            clearSelection();
            fireAndForget(list(target, undefined, false));
        },
        [clearSelection, list],
    );

    const enterFolder = useCallback(
        (name: string): void => {
            navigate(`${prefix}${name}`);
        },
        [navigate, prefix],
    );

    // Resolve a viewable (signed) URL for a thumbnail at a FIXED ttl — decoupled
    // from `expiry` so the Copy-URL dropdown never re-fetches every thumbnail.
    const resolveUrl = useCallback((key: string): Promise<string> => client.signedStorageUrl(key, { expiresInSeconds: THUMBNAIL_URL_TTL }), [client]);

    const showList = useCallback((): void => {
        setView("list");
    }, []);

    const showGrid = useCallback((): void => {
        setView("grid");
    }, []);

    const onSortKeyChange = useCallback((key: string): void => {
        setSortKey(key);
    }, []);

    const toggleSortDirection = useCallback((): void => {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    }, []);

    const onThumbSizeChange = useCallback((size: number): void => {
        setThumbSize(size);
    }, []);

    const onExpiryChange = useCallback((seconds: number): void => {
        setExpiry(seconds);
    }, []);

    // Delete every selected object (one schema-aware call each) then reload + clear.
    const bulkDelete = useCallback((): void => {
        setError(undefined);
        setBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    for (const key of selected) {
                        // eslint-disable-next-line no-await-in-loop -- one delete per selected object; sequential so a failure pins the offending key
                        await client.deleteStorageObject(key);
                    }

                    await list(prefix, undefined, false);
                    clearSelection();
                } catch (error_) {
                    setError(errorMessage(error_));
                } finally {
                    setBusy(false);
                }
            })(),
        );
    }, [clearSelection, client, list, prefix, selected]);

    const onCopy = useCallback(
        (key: string): void => {
            setError(undefined);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const url = await client.signedStorageUrl(key, { expiresInSeconds: expiry });

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

    // Resolve a (signed) URL for the object and trigger a browser download. The
    // filename is the key's basename; the link uses the toolbar's share lifetime.
    const onDownload = useCallback(
        (key: string): void => {
            setError(undefined);

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const url = await client.signedStorageUrl(key, { expiresInSeconds: expiry });
                        const filename = key.slice(key.lastIndexOf("/") + 1) || key;

                        triggerDownload(url, filename);
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
        if (copiedKey === undefined) {
            return undefined;
        }

        const timer = globalThis.setTimeout(() => {
            setCopiedKey(undefined);
        }, 2000);

        return () => {
            globalThis.clearTimeout(timer);
        };
    }, [copiedKey]);

    const onDelete = useCallback(
        (key: string): void => {
            setError(undefined);
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

    const onFile = useCallback(
        (file: File): void => {
            // Scope the upload key under the active prefix so it lands where the
            // operator is browsing.
            const key = `${prefix}${file.name}`;

            setError(undefined);
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

    // The orphan check spans the whole bucket against `referenceShard`'s records,
    // so a prior result goes stale the moment that shard changes — drop it so the
    // operator re-runs the check rather than reading a result for the old shard.
    useEffect(() => {
        setDanglingReferences(undefined);
        setDanglingTruncated(false);
    }, [referenceShard]);

    // Enumerate the bucket's live keys (bounded by ORPHAN_LIVE_KEY_CAP), then ask
    // the shard which record `v.storage()` fields point at a key NOT in that set —
    // a dangling reference. Best-effort: a worker that predates the feature (or a
    // closed admin gate) throws, surfaced as the error banner with an empty result.
    const checkOrphans = useCallback((): void => {
        setError(undefined);
        setDanglingBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const liveKeys: string[] = [];
                    let cursor: string | undefined;

                    do {
                        // eslint-disable-next-line no-await-in-loop -- bucket enumeration is inherently sequential (each page's cursor drives the next)
                        const page = await client.listStorageObjects({ cursor, limit: ORPHAN_LIST_PAGE_SIZE });

                        for (const object of page.objects) {
                            liveKeys.push(object.key);
                        }

                        cursor = liveKeys.length >= ORPHAN_LIVE_KEY_CAP ? undefined : page.cursor;
                    } while (cursor !== undefined);

                    const result = (await client.query(STORAGE_ORPHANS, { liveKeys }, callOptions(referenceShard))) as Partial<DanglingReferenceResult>;

                    setDanglingReferences(result.references ?? []);
                    setDanglingTruncated(result.truncated === true || liveKeys.length >= ORPHAN_LIVE_KEY_CAP);
                } catch (error_) {
                    setDanglingReferences([]);
                    setDanglingTruncated(false);
                    setError(errorMessage(error_));
                } finally {
                    setDanglingBusy(false);
                }
            })(),
        );
    }, [client, referenceShard]);

    return {
        allSelected,
        bulkDelete,
        busy,
        checkOrphans,
        clearSelection,
        copiedKey,
        danglingBusy,
        danglingReferences,
        danglingTruncated,
        draftPrefix,
        enterFolder,
        error,
        expiry,
        files: sortedFiles,
        folders,
        hasObjects: objects !== undefined && objects.length > 0,
        hasStorageColumns,
        listFirst,
        loaded: objects !== undefined,
        loadMore,
        navigate,
        nextCursor,
        onCopy,
        onDelete,
        onDownload,
        onExpiryChange,
        onFile,
        onSortKeyChange,
        onThumbSizeChange,
        prefix,
        referenceShard,
        references,
        resolveUrl,
        selected,
        setDraftPrefix,
        setReferenceShard,
        showGrid,
        showList,
        someSelected,
        sortDirection,
        sortKey,
        tagKeys,
        thumbSize,
        toggleSelect,
        toggleSelectAll,
        toggleSortDirection,
        view,
    };
};

export { THUMBNAIL_URL_TTL, useFileBrowser };
export type { FileBrowserModel, FileView };
