import type { StorageObject } from "@cirrus/client";
import type { ReactElement } from "react";
import { useCallback } from "react";

import { Checkbox } from "./components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import type { FileItemHandlers } from "./file-item";
import { FileActions, FileSelect, useFileItem } from "./file-item";
import type { TFunction } from "./i18n-context";
import { formatBytes } from "./internal";

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
            <TableCell colSpan={5}>
                <button
                    className="inline-flex items-center gap-2 font-mono text-xs outline-none hover:text-foreground focus-visible:text-foreground"
                    data-testid="fb-folder"
                    onClick={enter}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.6}
                        viewBox="0 0 24 24"
                    >
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                    </svg>
                    {name}
                </button>
            </TableCell>
        </TableRow>
    );
};

interface FileRowProps {
    readonly busy: boolean;
    readonly copiedKey: string | undefined;
    readonly handlers: FileItemHandlers;
    readonly object: StorageObject;
    /** Current folder prefix, stripped from the displayed name (the full key still drives actions). */
    readonly prefix: string;
    readonly selected: boolean;
    readonly t: TFunction;
}

/**
 * One object row. Per-item callbacks come from {@link useFileItem} (one stable
 * binding per render, shared with the gallery tile); the copy/delete actions +
 * select checkbox are the shared {@link FileActions} / {@link FileSelect}, so
 * the testids stay identical between list and grid. The name shows relative to
 * the current folder; the full key still scopes everything.
 */
const FileRow = ({ busy, copiedKey, handlers, object, prefix, selected, t }: FileRowProps): ReactElement => {
    const { copy, download, name, remove, toggle } = useFileItem(object, prefix, handlers);

    return (
        <TableRow data-testid="fb-row">
            <TableCell className="w-8">
                <FileSelect objectKey={object.key} onToggle={toggle} selected={selected} t={t} />
            </TableCell>
            <TableCell className="font-mono text-xs">{name}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{formatBytes(object.size)}</TableCell>
            <TableCell>{object.httpMetadata?.contentType ?? ""}</TableCell>
            <TableCell className="text-right">
                <span className="inline-flex items-center gap-1">
                    <FileActions
                        busy={busy}
                        copied={copiedKey === object.key}
                        objectKey={object.key}
                        onCopy={copy}
                        onDelete={remove}
                        onDownload={download}
                        t={t}
                    />
                </span>
            </TableCell>
        </TableRow>
    );
};

interface FileBrowserListProps {
    readonly allSelected: boolean;
    readonly busy: boolean;
    readonly copiedKey: string | undefined;
    readonly files: ReadonlyArray<StorageObject>;
    readonly folders: ReadonlyArray<string>;
    readonly handlers: FileItemHandlers;
    readonly onEnterFolder: (name: string) => void;
    readonly prefix: string;
    readonly selected: ReadonlySet<string>;
    readonly someSelected: boolean;
    readonly t: TFunction;
    readonly toggleSelectAll: () => void;
}

/**
 * The list (table) view: a select-all header, then folder rows followed by file
 * rows — mirroring how the gallery owns the grid. Presentational; the controller
 * supplies the data + handlers.
 */
const FileBrowserList = ({
    allSelected,
    busy,
    copiedKey,
    files,
    folders,
    handlers,
    onEnterFolder,
    prefix,
    selected,
    someSelected,
    t,
    toggleSelectAll,
}: FileBrowserListProps): ReactElement => (
    <div className="rounded-md border border-border">
        <Table data-testid="fb-table">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-8">
                        <Checkbox
                            aria-label={t("Select all rows")}
                            checked={allSelected}
                            data-testid="storage-select-all"
                            indeterminate={someSelected}
                            onCheckedChange={toggleSelectAll}
                        />
                    </TableHead>
                    <TableHead>{t("key")}</TableHead>
                    <TableHead>{t("size")}</TableHead>
                    <TableHead>{t("content-type")}</TableHead>
                    <TableHead aria-label={t("Actions")} />
                </TableRow>
            </TableHeader>
            <TableBody>
                {folders.map((folder) => (
                    <FolderRow key={folder} name={folder} onEnter={onEnterFolder} />
                ))}
                {files.map((object) => (
                    <FileRow
                        busy={busy}
                        copiedKey={copiedKey}
                        handlers={handlers}
                        key={object.key}
                        object={object}
                        prefix={prefix}
                        selected={selected.has(object.key)}
                        t={t}
                    />
                ))}
            </TableBody>
        </Table>
    </div>
);

export default FileBrowserList;
