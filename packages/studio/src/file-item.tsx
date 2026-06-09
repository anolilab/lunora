import type { StorageObject } from "@cirrus/client";
import type { ReactElement } from "react";
import { useCallback } from "react";

import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { ConfirmButton } from "./confirm-button";
import type { TFunction } from "./i18n-context";

/** The per-object action handlers shared by the list row and the gallery tile. */
interface FileItemHandlers {
    readonly onCopy: (key: string) => void;
    readonly onDelete: (key: string) => void;
    readonly onDownload: (key: string) => void;
    readonly onToggleSelect: (key: string) => void;
}

/** The per-object bindings derived by {@link useFileItem}. */
interface FileItem {
    /** Copy the object's URL (bound to the full key). */
    readonly copy: () => void;
    /** Download the object (bound to the full key). */
    readonly download: () => void;
    /** The display name relative to the current folder prefix. */
    readonly name: string;
    /** Delete the object (bound to the full key). */
    readonly remove: () => void;
    /** Toggle the object's selection (bound to the full key). */
    readonly toggle: () => void;
}

/**
 * One home for the per-item callbacks shared by the list row and the gallery
 * tile: each binds copy/delete/toggle to the object's full `key` via a stable
 * `useCallback` (react-perf, no fresh closure per render) and slices the display
 * `name` off the current folder `prefix`. The layout differs between views; only
 * this wiring is shared.
 */
const useFileItem = (object: StorageObject, prefix: string, handlers: FileItemHandlers): FileItem => {
    const { onCopy, onDelete, onDownload, onToggleSelect } = handlers;

    const copy = useCallback((): void => {
        onCopy(object.key);
    }, [onCopy, object.key]);

    const download = useCallback((): void => {
        onDownload(object.key);
    }, [onDownload, object.key]);

    const remove = useCallback((): void => {
        onDelete(object.key);
    }, [onDelete, object.key]);

    const toggle = useCallback((): void => {
        onToggleSelect(object.key);
    }, [onToggleSelect, object.key]);

    return { copy, download, name: object.key.slice(prefix.length), remove, toggle };
};

interface FileActionsProps {
    readonly busy: boolean;
    /** Copy-URL button class — the list and gallery size it slightly differently. */
    readonly buttonClassName?: string;
    /** True while this object's URL is the freshly-copied one (shows "Copied"). */
    readonly copied: boolean;
    /** The object key — scopes the action testids. */
    readonly objectKey: string;
    readonly onCopy: () => void;
    readonly onDelete: () => void;
    readonly onDownload: () => void;
    readonly t: TFunction;
}

/**
 * The shared copy-URL + download + confirm-delete action trio, with the canonical
 * `storage-copy-${key}` / `storage-download-${key}` / `storage-delete-${key}`
 * testids the studio tests rely on. Consumed by both the list row and the gallery
 * tile so the action wiring + testids live in one place.
 */
const FileActions = ({ busy, buttonClassName, copied, objectKey, onCopy, onDelete, onDownload, t }: FileActionsProps): ReactElement => (
    <>
        <Button className={buttonClassName} data-testid={`storage-copy-${objectKey}`} disabled={busy} onClick={onCopy} size="sm" type="button" variant="ghost">
            {copied ? t("Copied") : t("Copy URL")}
        </Button>
        <Button
            className={buttonClassName}
            data-testid={`storage-download-${objectKey}`}
            disabled={busy}
            onClick={onDownload}
            size="sm"
            type="button"
            variant="ghost"
        >
            {t("Download")}
        </Button>
        <ConfirmButton confirmLabel={t("Delete object?")} disabled={busy} onConfirm={onDelete} testId={`storage-delete-${objectKey}`}>
            {t("Delete")}
        </ConfirmButton>
    </>
);

interface FileSelectProps {
    readonly objectKey: string;
    readonly onToggle: () => void;
    readonly selected: boolean;
    readonly t: TFunction;
}

/** The shared per-row selection checkbox with the canonical `storage-select-${key}` testid. */
const FileSelect = ({ objectKey, onToggle, selected, t }: FileSelectProps): ReactElement => (
    <Checkbox aria-label={t("Select row")} checked={selected} data-testid={`storage-select-${objectKey}`} onCheckedChange={onToggle} />
);

export { FileActions, FileSelect, useFileItem };
export type { FileItemHandlers };
