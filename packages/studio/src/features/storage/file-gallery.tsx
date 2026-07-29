import type { StorageObject } from "@lunora/client";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";

import type { TFunction } from "../../i18n/i18n-context";
import type { StorageReference } from "../../lib/admin";
import { fireAndForget, formatBytes } from "../../lib/internal";
import type { FileItemHandlers } from "./file-item";
import { FileActions, fileItemBindings, FileReferences, FileSelect } from "./file-item";

/** File extensions that render as an image thumbnail when the content-type is absent. */
const IMAGE_EXTENSION_RE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu;

/** True when an object is an image (by content-type, falling back to its key's extension). */
const isImage = (object: StorageObject): boolean => (object.httpMetadata?.contentType ?? "").startsWith("image/") || IMAGE_EXTENSION_RE.test(object.key);

/** A generic file glyph for non-image tiles (and the image loading/error placeholder). */
const FileGlyph = (): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-8 text-muted-foreground/60"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
        viewBox="0 0 24 24"
    >
        <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h5" />
    </svg>
);

interface ThumbnailProps {
    readonly object: StorageObject;
    /** Resolve a viewable URL for an image key (the parent's signed-URL fetch). */
    readonly resolveUrl: (key: string) => Promise<string>;
}

/**
 * The square preview area of a tile. Image objects lazily resolve a (signed)
 * URL on mount and render an image element that covers the square; non-images —
 * and images that fail to load or resolve — show a file glyph. The URL fetch is
 * cancelled on unmount so a scrolled-away tile never sets state late.
 */
const Thumbnail = ({ object, resolveUrl }: ThumbnailProps): ReactElement => {
    const [url, setUrl] = useState<null | string>(null);
    const [failed, setFailed] = useState<boolean>(false);
    const image = isImage(object);

    useEffect(() => {
        if (!image) {
            return undefined;
        }

        // Object flag (not a `let`) so the cancel check isn't narrowed away.
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const resolved = await resolveUrl(object.key);

                    if (!token.cancelled) {
                        setUrl(resolved);
                    }
                } catch {
                    if (!token.cancelled) {
                        setFailed(true);
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [image, object.key, resolveUrl]);

    const onError = (): void => {
        setFailed(true);
    };

    return (
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/30">
            {image && url !== null && !failed ? (
                <img alt={object.key} className="size-full object-cover" loading="lazy" onError={onError} src={url} />
            ) : (
                <FileGlyph />
            )}
        </div>
    );
};

interface GalleryTileProps {
    readonly busy: boolean;
    readonly copiedKey: string | undefined;
    readonly handlers: FileItemHandlers;
    readonly object: StorageObject;
    readonly prefix: string;
    /** Rows that reference this object (via a `v.storage()` column); `undefined` while resolving. */
    readonly references: ReadonlyArray<StorageReference> | undefined;
    readonly resolveUrl: (key: string) => Promise<string>;
    readonly selected: boolean;
    /** Whether the schema models storage refs at all — gates the used-by/orphan badge. */
    readonly showReferences: boolean;
    readonly t: TFunction;
}

/**
 * One gallery tile: a thumbnail (with a selection checkbox overlay), the name
 * relative to the current folder, its size, and copy/delete actions. Per-item
 * bindings + the action/select controls are the shared {@link fileItemBindings} /
 * {@link FileActions} / {@link FileSelect}, mirroring the list view's file row
 * (only the tile layout differs).
 */
const GalleryTile = ({ busy, copiedKey, handlers, object, prefix, references, resolveUrl, selected, showReferences, t }: GalleryTileProps): ReactElement => {
    const { copy, download, name, remove, toggle } = fileItemBindings(object, prefix, handlers);

    return (
        <div className="flex flex-col gap-1.5" data-testid="fb-tile">
            <div className="relative">
                <Thumbnail object={object} resolveUrl={resolveUrl} />
                <span className="absolute left-1.5 top-1.5 rounded bg-background/80 p-0.5">
                    <FileSelect objectKey={object.key} onToggle={toggle} selected={selected} t={t} />
                </span>
            </div>
            <div className="min-w-0">
                <p className="truncate font-mono text-xs" title={name}>
                    {name}
                </p>
                <p className="text-[11px] tabular-nums text-muted-foreground">{formatBytes(object.size)}</p>
                {showReferences && (
                    <div className="mt-1">
                        <FileReferences objectKey={object.key} references={references} t={t} />
                    </div>
                )}
            </div>
            <div className="flex items-center gap-1">
                <FileActions
                    busy={busy}
                    buttonClassName="h-7 px-2 text-xs"
                    copied={copiedKey === object.key}
                    objectKey={object.key}
                    onCopy={copy}
                    onDelete={remove}
                    onDownload={download}
                    t={t}
                />
            </div>
        </div>
    );
};

/** One folder tile in the gallery — a folder glyph + name; clicking descends. */
const FolderTile = ({ name, onEnter }: { readonly name: string; readonly onEnter: (name: string) => void }): ReactElement => {
    const enter = (): void => {
        onEnter(name);
    };

    return (
        <button className="flex flex-col gap-1.5 text-left outline-none" data-testid="fb-folder" onClick={enter} type="button">
            <span className="flex aspect-square w-full items-center justify-center rounded-md border border-border bg-muted/30 transition-colors hover:bg-accent">
                <svg
                    aria-hidden="true"
                    className="size-10 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.4}
                    viewBox="0 0 24 24"
                >
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                </svg>
            </span>
            <span className="truncate font-mono text-xs" title={name}>
                {name}
            </span>
        </button>
    );
};

interface FileGalleryProps {
    readonly busy: boolean;
    readonly copiedKey: string | undefined;
    readonly files: ReadonlyArray<StorageObject>;
    readonly folders: ReadonlyArray<string>;
    readonly handlers: FileItemHandlers;
    readonly onEnterFolder: (name: string) => void;
    readonly prefix: string;
    /** Rows referencing each object key (via a `v.storage()` column), keyed by key. */
    readonly references: Readonly<Record<string, ReadonlyArray<StorageReference>>>;
    readonly resolveUrl: (key: string) => Promise<string>;
    readonly selected: ReadonlySet<string>;
    /** Whether the schema declares any `v.storage()` columns — gates the used-by/orphan badge. */
    readonly showReferences: boolean;
    /** Tile column width in px — the slider resizes thumbnails live via the grid template. */
    readonly size: number;
    readonly t: TFunction;
}

/**
 * The grid (thumbnail) view of the file listing: folder tiles first, then file
 * tiles. Tiles flow into as many columns as fit at the current `size`, so dragging
 * the size control re-flows and resizes every thumbnail on the fly (pure CSS — no
 * re-fetch).
 */
const FileGallery = ({
    busy,
    copiedKey,
    files,
    folders,
    handlers,
    onEnterFolder,
    prefix,
    references,
    resolveUrl,
    selected,
    showReferences,
    size,
    t,
}: FileGalleryProps): ReactElement => {
    // The only dynamic style: the column width tracks the size slider.

    const gridStyle: CSSProperties = { gridTemplateColumns: `repeat(auto-fill, minmax(${size.toString()}px, 1fr))` };

    return (
        <div className="grid gap-4" data-testid="fb-gallery" style={gridStyle}>
            {folders.map((folder) => (
                <FolderTile key={folder} name={folder} onEnter={onEnterFolder} />
            ))}
            {files.map((object) => (
                <GalleryTile
                    busy={busy}
                    copiedKey={copiedKey}
                    handlers={handlers}
                    key={object.key}
                    object={object}
                    prefix={prefix}
                    references={references[object.key]}
                    resolveUrl={resolveUrl}
                    selected={selected.has(object.key)}
                    showReferences={showReferences}
                    t={t}
                />
            ))}
        </div>
    );
};

export default FileGallery;
