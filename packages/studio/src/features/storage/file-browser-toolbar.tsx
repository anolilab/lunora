import type { ChangeEvent, ReactElement, RefObject } from "react";
import { useCallback } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type { TFunction } from "../../i18n/i18n-context";
import { CLOUDFLARE_R2_URL } from "../../lib/cf-links";
import type { FileView } from "./hooks/use-file-browser";
import { SHARE_LIFETIMES } from "./storage-entries";

interface FileBrowserToolbarProps {
    /** The selected bucket (`""` = default); drives the picker's value. */
    readonly bucket: string;
    /** Bucket names; an empty list hides the picker (single-bucket deployment). */
    readonly buckets: ReadonlyArray<string>;
    readonly busy: boolean;
    readonly draftPrefix: string;
    readonly expiry: number;
    readonly fileInputRef: RefObject<HTMLInputElement | null>;
    readonly onBucketChange: (name: string) => void;
    readonly onExpiryChange: (seconds: number) => void;
    readonly onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly onList: () => void;
    readonly onPrefixChange: (prefix: string) => void;
    readonly onUploadClick: () => void;
    readonly t: TFunction;
}

/**
 * The top control bar: the key-prefix input, List + Upload buttons (with the
 * hidden file input), and the share-link "Link expiry" select. Presentational —
 * every value + handler comes from the controller's view-model.
 */
const FileBrowserToolbar = ({
    bucket,
    buckets,
    busy,
    draftPrefix,
    expiry,
    fileInputRef,
    onBucketChange,
    onExpiryChange,
    onFileChange,
    onList,
    onPrefixChange,
    onUploadClick,
    t,
}: FileBrowserToolbarProps): ReactElement => {
    const onPrefixInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            onPrefixChange(event.target.value);
        },
        [onPrefixChange],
    );

    const onBucketSelect = useCallback(
        (event: ChangeEvent<HTMLSelectElement>): void => {
            onBucketChange(event.target.value);
        },
        [onBucketChange],
    );

    const onExpirySelect = useCallback(
        (event: ChangeEvent<HTMLSelectElement>): void => {
            onExpiryChange(Number.parseInt(event.target.value, 10));
        },
        [onExpiryChange],
    );

    return (
        <div className="flex flex-wrap items-center gap-2">
            {buckets.length > 0 && (
                <select
                    aria-label={t("Bucket")}
                    className="h-8 rounded-md border border-border bg-background px-1 outline-none focus-visible:border-ring"
                    data-testid="fb-bucket"
                    onChange={onBucketSelect}
                    value={bucket}
                >
                    {buckets.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
            )}
            <Input
                aria-label={t("Key prefix")}
                className="h-8 w-64 max-w-full"
                data-testid="fb-prefix-input"
                onChange={onPrefixInput}
                placeholder={t("key prefix (optional)")}
                value={draftPrefix}
            />
            <Button data-testid="fb-list" disabled={busy} onClick={onList} size="sm" type="button">
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
                    onChange={onExpirySelect}
                    value={expiry}
                >
                    {SHARE_LIFETIMES.map((lifetime) => (
                        <option key={lifetime.seconds} value={lifetime.seconds}>
                            {t(lifetime.label)}
                        </option>
                    ))}
                </select>
            </label>
            <a
                className="text-sm text-primary underline-offset-4 hover:underline"
                data-testid="fb-cf-link"
                href={CLOUDFLARE_R2_URL}
                rel="noreferrer"
                target="_blank"
            >
                {t("Open in Cloudflare")}
            </a>
        </div>
    );
};

interface FileBrowserControlsProps {
    readonly onSortKeyChange: (key: string) => void;
    readonly onThumbSizeChange: (size: number) => void;
    readonly showGrid: () => void;
    readonly showList: () => void;
    readonly sortDirection: "asc" | "desc";
    readonly sortKey: string;
    readonly t: TFunction;
    readonly tagKeys: ReadonlyArray<string>;
    readonly thumbSize: number;
    readonly toggleSortDirection: () => void;
    readonly view: FileView;
}

/**
 * The view-toggle / sort select + direction / thumbnail-size control bar shown
 * once a listing has loaded. Presentational; props come from the controller.
 */
const FileBrowserControls = ({
    onSortKeyChange,
    onThumbSizeChange,
    showGrid,
    showList,
    sortDirection,
    sortKey,
    t,
    tagKeys,
    thumbSize,
    toggleSortDirection,
    view,
}: FileBrowserControlsProps): ReactElement => {
    const onSortSelect = useCallback(
        (event: ChangeEvent<HTMLSelectElement>): void => {
            onSortKeyChange(event.target.value);
        },
        [onSortKeyChange],
    );

    const onThumbInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            onThumbSizeChange(Number.parseInt(event.target.value, 10));
        },
        [onThumbSizeChange],
    );

    return (
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
                    onChange={onSortSelect}
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
                        onChange={onThumbInput}
                        step={8}
                        type="range"
                        value={thumbSize}
                    />
                </label>
            )}
        </div>
    );
};

export { FileBrowserControls, FileBrowserToolbar };
