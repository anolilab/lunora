import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useMemo, useRef } from "react";

import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { SelectionBar } from "../data/grid-features";
import FileBrowserList from "./file-browser-list";
import { FileBrowserControls, FileBrowserToolbar } from "./file-browser-toolbar";
import FileGallery from "./file-gallery";
import type { FileItemHandlers } from "./file-item";
import { OrphanedObjectsSection } from "./file-orphans";
import { useFileBrowser } from "./hooks/use-file-browser";

interface FileBrowserProps {
    /** Object-key prefix the browser filters by on first load. */
    readonly initialPrefix?: string;
    /** Objects requested per page. Forwarded to the storage `list` limit. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

interface BreadcrumbsProps {
    readonly onNavigate: (prefix: string) => void;
    readonly prefix: string;
    readonly t: TFunction;
}

/** One breadcrumb segment — extracted so each binds its own navigate target. */
const Crumb = ({
    label,
    onNavigate,
    target,
}: {
    readonly label: string;
    readonly onNavigate: (prefix: string) => void;
    readonly target: string;
}): ReactElement => {
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
 *
 * All state + behavior lives in {@link useFileBrowser}; this shell only wires the
 * view-model into the toolbar, breadcrumbs, selection bar, list/gallery and the
 * load-more / error / empty affordances.
 */
export const FileBrowser = ({ initialPrefix, pageSize = DEFAULT_PAGE_SIZE }: FileBrowserProps): ReactElement => {
    const t = useT();
    const vm = useFileBrowser({ initialPrefix, pageSize });
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { onCopy, onDelete, onDownload, onFile, toggleSelect } = vm;

    const handlers = useMemo<FileItemHandlers>(() => {
        return { onCopy, onDelete, onDownload, onToggleSelect: toggleSelect };
    }, [onCopy, onDelete, onDownload, toggleSelect]);

    const onUploadClick = useCallback((): void => {
        fileInputRef.current?.click();
    }, []);

    const onFileChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            const input = event.target;
            const file = input.files?.[0];

            // Reset the input so picking the same file again re-fires `change`.
            input.value = "";

            if (file) {
                onFile(file);
            }
        },
        [onFile],
    );

    const empty = vm.loaded && !vm.hasObjects;

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-file-browser">
            <FileBrowserToolbar
                bucket={vm.bucket}
                buckets={vm.buckets}
                busy={vm.busy}
                draftPrefix={vm.draftPrefix}
                expiry={vm.expiry}
                fileInputRef={fileInputRef}
                onBucketChange={vm.selectBucket}
                onExpiryChange={vm.onExpiryChange}
                onFileChange={onFileChange}
                onList={vm.listFirst}
                onPrefixChange={vm.setDraftPrefix}
                onUploadClick={onUploadClick}
                t={t}
            />

            {vm.loaded && <Breadcrumbs onNavigate={vm.navigate} prefix={vm.prefix} t={t} />}

            {vm.hasObjects && (
                <FileBrowserControls
                    onSortKeyChange={vm.onSortKeyChange}
                    onThumbSizeChange={vm.onThumbSizeChange}
                    showGrid={vm.showGrid}
                    showList={vm.showList}
                    sortDirection={vm.sortDirection}
                    sortKey={vm.sortKey}
                    t={t}
                    tagKeys={vm.tagKeys}
                    thumbSize={vm.thumbSize}
                    toggleSortDirection={vm.toggleSortDirection}
                    view={vm.view}
                />
            )}

            {vm.hasStorageColumns && (
                <div className="flex flex-wrap items-center gap-2" data-testid="fb-references-shard">
                    <label className="text-xs text-muted-foreground" htmlFor="fb-reference-shard-input">
                        {t("References shard")}
                    </label>
                    <ShardInput id="fb-reference-shard-input" onChange={vm.setReferenceShard} testId="fb-reference-shard-input" value={vm.referenceShard} />
                    <span className="text-xs text-muted-foreground">
                        {t("Which shard's records are checked for references to these files. Empty = root shard.")}
                    </span>
                </div>
            )}

            {vm.hasStorageColumns && (
                <OrphanedObjectsSection
                    busy={vm.danglingBusy}
                    onCheck={vm.checkOrphans}
                    references={vm.danglingReferences}
                    t={t}
                    truncated={vm.danglingTruncated}
                />
            )}

            {vm.selected.size > 0 && <SelectionBar count={vm.selected.size} editable onClear={vm.clearSelection} onDelete={vm.bulkDelete} />}

            {vm.error !== undefined && (
                <p className="text-sm text-destructive" data-testid="storage-error" role="alert">
                    {vm.error}
                </p>
            )}

            {empty && (
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

            {vm.hasObjects && vm.view === "list" && (
                <FileBrowserList
                    allSelected={vm.allSelected}
                    busy={vm.busy}
                    copiedKey={vm.copiedKey}
                    files={vm.files}
                    folders={vm.folders}
                    handlers={handlers}
                    onEnterFolder={vm.enterFolder}
                    prefix={vm.prefix}
                    references={vm.references}
                    selected={vm.selected}
                    showReferences={vm.hasStorageColumns}
                    someSelected={vm.someSelected}
                    t={t}
                    toggleSelectAll={vm.toggleSelectAll}
                />
            )}

            {vm.hasObjects && vm.view === "grid" && (
                <FileGallery
                    busy={vm.busy}
                    copiedKey={vm.copiedKey}
                    files={vm.files}
                    folders={vm.folders}
                    handlers={handlers}
                    onEnterFolder={vm.enterFolder}
                    prefix={vm.prefix}
                    references={vm.references}
                    resolveUrl={vm.resolveUrl}
                    selected={vm.selected}
                    showReferences={vm.hasStorageColumns}
                    size={vm.thumbSize}
                    t={t}
                />
            )}

            {vm.nextCursor !== undefined && (
                <div>
                    <Button data-testid="fb-next" disabled={vm.busy} onClick={vm.loadMore} size="sm" type="button" variant="outline">
                        {t("Load more")}
                    </Button>
                </div>
            )}
        </div>
    );
};

export type { FileBrowserProps };
