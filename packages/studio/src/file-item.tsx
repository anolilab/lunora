import type { StorageObject } from "@cirrus/client";
import type { ReactElement } from "react";
import { useCallback } from "react";

import type { StorageReference } from "./admin";
import { Badge } from "./components/ui/badge";
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

interface FileReferencesProps {
    /** The object key — scopes the testid. */
    readonly objectKey: string;
    /** Rows that reference this object (via a `v.storage()` column). `undefined` = not yet resolved. */
    readonly references: ReadonlyArray<StorageReference> | undefined;
    readonly t: TFunction;
}

/**
 * The records↔files join indicator for one object (PLAN3 §1.3): a muted "used by
 * N" badge when one or more rows reference the object (titled with each owning
 * `table·id`, the join CF structurally cannot show), or an "Orphan" badge when no
 * row on the queried shard references it. Renders nothing while references are
 * still resolving (`undefined`), so the cell stays empty rather than flashing a
 * false orphan.
 */
const FileReferences = ({ objectKey, references, t }: FileReferencesProps): null | ReactElement => {
    if (references === undefined) {
        return null;
    }

    if (references.length === 0) {
        return (
            <Badge className="border-amber-500/40 text-amber-600 dark:text-amber-400" data-testid={`storage-orphan-${objectKey}`} variant="outline">
                {t("Orphan")}
            </Badge>
        );
    }

    const owners = references.map((reference) => `${reference.table}·${reference.id}`).join("\n");

    return (
        <Badge data-testid={`storage-refs-${objectKey}`} title={owners} variant="secondary">
            {references.length === 1 ? t("1 record") : t("{count} records", { count: references.length })}
        </Badge>
    );
};

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

export { FileActions, FileReferences, FileSelect, useFileItem };
export type { FileItemHandlers };
