import type { StorageListPage, StorageObject } from "@lunora/client";
import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAutoRefresh } from "../../../hooks/use-auto-refresh";
import type { DanglingReference, DanglingReferenceResult, StorageReference, StorageReferenceResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, copyToClipboard, errorMessage, fireAndForget } from "../../../lib/internal";
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

/**
 * Walk the bucket for the orphan check's live-key set, stopping at
 * {@link ORPHAN_LIVE_KEY_CAP}.
 *
 * `truncated` is set only when the cap stopped the walk with pages still to come:
 * a bucket of exactly the cap that enumerated to its end IS complete, and calling
 * that truncated would suppress a verdict the check could have given.
 */
const enumerateLiveKeys = async (storageApi: {
    list: (options: { cursor?: string; limit?: number }) => Promise<StorageListPage>;
}): Promise<{
    liveKeys: string[];
    truncated: boolean;
}> => {
    const liveKeys: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore && liveKeys.length < ORPHAN_LIVE_KEY_CAP) {
        // eslint-disable-next-line no-await-in-loop -- bucket enumeration is inherently sequential (each page's cursor drives the next)
        const page = await storageApi.list({ cursor, limit: ORPHAN_LIST_PAGE_SIZE });

        for (const object of page.objects) {
            liveKeys.push(object.key);
        }

        cursor = page.cursor;
        hasMore = cursor !== undefined;
    }

    // Pages still pending when the walk stopped ⇒ the cap cut it short.
    return { liveKeys, truncated: hasMore };
};

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
    /** The selected bucket (`""` = the worker's default bucket). */
    readonly bucket: string;
    /** Storage bucket names the worker exposes; empty hides the picker (single-bucket). */
    readonly buckets: ReadonlyArray<string>;
    readonly bulkDelete: () => void;
    readonly busy: boolean;
    /** Enumerate the bucket and resolve the dangling references (records pointing at missing objects) on `referenceShard`. */
    readonly checkOrphans: () => void;
    readonly clearSelection: () => void;
    readonly copiedKey: string | undefined;
    /** `true` while the orphan check is enumerating the bucket / resolving dangling references. */
    readonly danglingBusy: boolean;
    /** Record `v.storage()` fields whose value points at an object the bucket no longer has; `undefined` whenever there is no verdict — not yet run, truncated, or failed. */
    readonly danglingReferences: ReadonlyArray<DanglingReference> | undefined;
    /** `true` when the orphan check's scan was clipped by a bound — the dangling list is partial, or absent entirely. */
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
    /** Switch the active bucket (resets navigation + re-lists). */
    readonly selectBucket: (name: string) => void;
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

/** Selection identity for a bucket object: its full key. */
const keyOf = (object: StorageObject): string => object.key;

const useFileBrowser = ({ initialPrefix, pageSize }: UseFileBrowserOptions): FileBrowserModel => {
    const client = useLunora();

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
    // Multi-bucket support: the picker's options + the selected bucket (`""` = the
    // worker's default bucket). All storage ops are scoped to it. Empty `buckets`
    // (single-bucket / older worker) hides the picker entirely.
    const [buckets, setBuckets] = useState<string[]>([]);
    const [bucket, setBucket] = useState<string>("");

    // Monotonic request ids so an out-of-order response can't overwrite a newer
    // scope. `list()` fires from many triggers (mount, prefix List, folder-nav,
    // Load-more, poll tick, post-write reload, bucket switch); the orphan check
    // walks the whole bucket against `referenceShard`. In both, a slow response for
    // a superseded prefix/bucket/shard used to win by resolving last — the guards
    // below discard any result whose id is no longer the latest.
    const listSeq = useRef(0);
    const orphanSeq = useRef(0);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const names = await client.listStorageBuckets();

                    if (!token.cancelled) {
                        setBuckets(names);

                        // Default-select the first bucket so the picker's value matches
                        // a real option; leaving `""` would show no selection.
                        const [first] = names;

                        if (first !== undefined) {
                            setBucket((current) => (current === "" ? first : current));
                        }
                    }
                } catch {
                    // Single-bucket deployment or a worker predating the picker: no picker.
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client]);

    // Per-bucket client facade: every storage op is scoped to the active `bucket`
    // in ONE place, so a call site can't forget to pass it, and the callbacks
    // below depend on `storageApi` (which re-identifies on bucket change) instead
    // of re-listing `bucket` at each site — closing the stale-bucket dep-array
    // footgun by construction.
    const storageApi = useMemo(() => {
        return {
            list: (options: { cursor?: string; limit?: number; prefix?: string }) => client.listStorageObjects({ ...options, bucket }),
            remove: (key: string) => client.deleteStorageObject(key, { bucket }),
            signedUrl: (key: string, options?: { expiresInSeconds?: number }) => client.signedStorageUrl(key, { ...options, bucket }),
            upload: (options: { body: ArrayBuffer | Blob; contentType?: string; key: string }) => client.uploadStorageObject({ ...options, bucket }),
        };
    }, [bucket, client]);

    const list = useCallback(
        async (searchPrefix: string, cursor: string | undefined, append: boolean): Promise<void> => {
            listSeq.current += 1;
            const seq = listSeq.current;

            setError(undefined);
            setBusy(true);

            // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `finally`, and this one cannot be flattened: the `try` returns early, and the busy flag has to be released on that path too
            try {
                const page = await storageApi.list({ cursor, limit: pageSize, prefix: searchPrefix });

                // A newer list() (fast folder-nav, bucket switch, poll tick) has
                // superseded this one — drop the stale page so an out-of-order
                // response can't render a prior prefix/bucket's rows under the new scope.
                if (seq !== listSeq.current) {
                    return;
                }

                setObjects((previous) => (append && previous !== undefined ? [...previous, ...page.objects] : page.objects));
                setNextCursor(page.cursor);
            } catch (error_) {
                if (seq !== listSeq.current) {
                    return;
                }

                if (!append) {
                    setObjects(undefined);
                }

                setError(errorMessage(error_));
            } finally {
                // Leave `busy` for the superseding request to clear (it set it too).
                if (seq === listSeq.current) {
                    setBusy(false);
                }
            }
        },
        [pageSize, storageApi],
    );

    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async listing on mount and on prefix change
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
    const { files, folders } = deriveEntries(objects ?? [], prefix);

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

    const sortedFiles = sortFiles(files, sortKey, sortDirection);

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
            // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async records-to-files join for the loaded keys, with a cancellation flag
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

    const {
        allSelected,
        clear: clearSelection,
        selected,
        someSelected,
        toggle: toggleSelect,
        toggleAll: toggleSelectAll,
    }: KeySelection = useKeySelection(sortedFiles, keyOf);

    const listFirst = (): void => {
        setPrefix(draftPrefix);
        // Scope change: the loaded objects are about to change under the selection,
        // so clear it to prevent stale keys from a prior prefix being bulk-deleted
        // against the new listing.
        clearSelection();
        fireAndForget(list(draftPrefix, undefined, false));
    };

    const loadMore = (): void => {
        fireAndForget(list(prefix, nextCursor, true));
    };

    // Navigate to a folder prefix (breadcrumb or folder row) and reload from its
    // first page. Both the loaded + draft prefix track the new target, and the
    // selection resets (the loaded rows change underneath it).
    const navigate = (target: string): void => {
        setPrefix(target);
        setDraftPrefix(target);
        clearSelection();
        fireAndForget(list(target, undefined, false));
    };

    const enterFolder = (name: string): void => {
        navigate(`${prefix}${name}`);
    };

    // Resolve a viewable (signed) URL for a thumbnail at a FIXED ttl — decoupled
    // from `expiry` so the Copy-URL dropdown never re-fetches every thumbnail.
    const resolveUrl = (key: string): Promise<string> => storageApi.signedUrl(key, { expiresInSeconds: THUMBNAIL_URL_TTL });

    const showList = (): void => {
        setView("list");
    };

    const showGrid = (): void => {
        setView("grid");
    };

    const onSortKeyChange = (key: string): void => {
        setSortKey(key);
    };

    const toggleSortDirection = (): void => {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    };

    const onThumbSizeChange = (size: number): void => {
        setThumbSize(size);
    };

    const onExpiryChange = (seconds: number): void => {
        setExpiry(seconds);
    };

    // Delete every selected object (one schema-aware call each) then reload + clear.
    const bulkDelete = (): void => {
        setError(undefined);
        setBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    for (const key of selected) {
                        /* eslint-disable no-await-in-loop -- one delete per selected object; sequential so a failure pins the offending key */
                        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: R2 deletes are ordered so a failure pins the offending key instead of leaving a half-applied batch
                        await storageApi.remove(key);
                        /* eslint-enable no-await-in-loop */
                    }

                    await list(prefix, undefined, false);
                    clearSelection();
                } catch (error_) {
                    setError(errorMessage(error_));
                }

                setBusy(false);
            })(),
        );
    };

    const onCopy = (key: string): void => {
        setError(undefined);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const url = await storageApi.signedUrl(key, { expiresInSeconds: expiry });

                    // The shared helper returns whether a clipboard was available, so skip
                    // the transient "Copied" acknowledgement when there was none to write to.
                    if (copyToClipboard(url)) {
                        setCopiedKey(key);
                    }
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
    };

    // Resolve a (signed) URL for the object and trigger a browser download. The
    // filename is the key's basename; the link uses the toolbar's share lifetime.
    const onDownload = (key: string): void => {
        setError(undefined);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const url = await storageApi.signedUrl(key, { expiresInSeconds: expiry });
                    const filename = key.slice(key.lastIndexOf("/") + 1) || key;

                    triggerDownload(url, filename);
                } catch (error_) {
                    setError(errorMessage(error_));
                }
            })(),
        );
    };

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

    const onDelete = (key: string): void => {
        setError(undefined);
        setBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await storageApi.remove(key);
                    await list(prefix, undefined, false);
                } catch (error_) {
                    setError(errorMessage(error_));
                }

                setBusy(false);
            })(),
        );
    };

    const onFile = (file: File): void => {
        // Scope the upload key under the active prefix so it lands where the
        // operator is browsing.
        const key = `${prefix}${file.name}`;

        setError(undefined);
        setBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const body = await file.arrayBuffer();

                    await storageApi.upload({ body, contentType: file.type === "" ? undefined : file.type, key });
                    await list(prefix, undefined, false);
                } catch (error_) {
                    setError(errorMessage(error_));
                }

                setBusy(false);
            })(),
        );
    };

    // The orphan check spans the whole bucket against `referenceShard`'s records,
    // so a prior result goes stale the moment that shard changes — drop it so the
    // operator re-runs the check rather than reading a result for the old shard.
    useEffect(() => {
        // Invalidate any in-flight orphan check so its (old-shard) result can't land.
        orphanSeq.current += 1;
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- invalidates a whole-bucket orphan result when the reference shard changes; a stale result must not survive the switch
        // react-doctor-disable-next-line react-doctor/no-chain-state-updates -- invalidating the orphan result is one logical reset split across two pieces of state; merging them would mean a wider state object for no behavioural gain
        setDanglingReferences(undefined);
        // react-doctor-disable-next-line react-doctor/no-chain-state-updates -- invalidating the orphan result is one logical reset split across two pieces of state; merging them would mean a wider state object for no behavioural gain
        setDanglingTruncated(false);
    }, [referenceShard]);

    // Enumerate the bucket's live keys (bounded by ORPHAN_LIVE_KEY_CAP), then ask
    // the shard which record `v.storage()` fields point at a key NOT in that set —
    // a dangling reference. Best-effort: a worker that predates the feature (or a
    // closed admin gate) throws, surfaced as the error banner with an empty result.
    const checkOrphans = (): void => {
        orphanSeq.current += 1;
        const seq = orphanSeq.current;

        setError(undefined);
        setDanglingBusy(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const { liveKeys, truncated: enumTruncated } = await enumerateLiveKeys(storageApi);

                    if (enumTruncated) {
                        // The live-key set is incomplete: running storageOrphans with a
                        // partial key set would flag in-bucket objects as dangling simply
                        // because they weren't reached during enumeration. So the check
                        // produced NO verdict — `undefined`, not an empty list, which the
                        // panel renders as "every reference resolves".
                        if (seq === orphanSeq.current) {
                            setDanglingReferences(undefined);
                            setDanglingTruncated(true);
                        }
                    } else {
                        const result = (await client.query(STORAGE_ORPHANS, { liveKeys }, callOptions(referenceShard))) as Partial<DanglingReferenceResult>;

                        // A bucket/shard switch since this check began invalidated it —
                        // don't paint a result computed against the previous scope.
                        if (seq === orphanSeq.current) {
                            setDanglingReferences(result.references ?? []);
                            setDanglingTruncated(result.truncated === true);
                        }
                    }
                } catch (error_) {
                    if (seq === orphanSeq.current) {
                        // No verdict either: an empty list here would paint the all-clear
                        // right beside the error banner that says the check failed.
                        setDanglingReferences(undefined);
                        setDanglingTruncated(false);
                        setError(errorMessage(error_));
                    }
                }

                if (seq === orphanSeq.current) {
                    setDanglingBusy(false);
                }
            })(),
        );
    };

    // Switch buckets: reset navigation to the initial prefix; the `list` callback's
    // identity changes (it closes over `bucket`), so the mount effect re-lists.
    // Clear selection so keys from the previous bucket are never bulk-deleted against
    // the newly-active bucket — the primary stale-selection bug vector.
    const selectBucket = (name: string): void => {
        // Invalidate any in-flight list / orphan check for the previous bucket so a
        // late response can't paint its rows or dangling report under the new bucket.
        listSeq.current += 1;
        orphanSeq.current += 1;
        setBucket(name);
        setPrefix(initialPrefix ?? "");
        setDraftPrefix(initialPrefix ?? "");
        setObjects(undefined);
        // The dangling report was computed for the previous bucket's keys — drop it
        // (the shard-change effect only clears it on `referenceShard`, not bucket).
        setDanglingReferences(undefined);
        setDanglingTruncated(false);
        clearSelection();
    };

    return {
        allSelected,
        bucket,
        buckets,
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
        selectBucket,
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

/**
 * The file browser's controller: owns all listing/pagination, prefix +
 * folder-navigation, sort, view + thumbnail-size, share-link expiry, selection +
 * bulk delete, copy, delete and upload state, and composes {@link useKeySelection}.
 * Returns a flat {@link FileBrowserModel} so the panel + toolbar + list/gallery
 * stay presentational.
 */
export { enumerateLiveKeys, ORPHAN_LIVE_KEY_CAP, THUMBNAIL_URL_TTL, useFileBrowser };
export type { FileBrowserModel, FileView };
