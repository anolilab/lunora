import type { StorageObject } from "@lunora/client";
import type { ReactElement } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { TFunction } from "../../i18n/i18n-context";
import type { StorageReference } from "../../lib/admin";
import { formatBytes } from "../../lib/internal";
import type { FileItemHandlers } from "./file-item";
import { FileActions, fileItemBindings, FileReferences, FileSelect } from "./file-item";

interface FolderRowProps {
    /** Total table columns to span — varies with the optional "used by" column. */
    readonly colSpan: number;
    readonly name: string;
    readonly onEnter: (name: string) => void;
}

/** One folder row — a folder glyph + name; clicking descends into it. */
const FolderRow = ({ colSpan, name, onEnter }: FolderRowProps): ReactElement => {
    const enter = (): void => {
        onEnter(name);
    };

    return (
        <TableRow>
            <TableCell colSpan={colSpan}>
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
    /** Rows that reference this object (via a `v.storage()` column); `undefined` while resolving. */
    readonly references: ReadonlyArray<StorageReference> | undefined;
    readonly selected: boolean;
    /** Whether the schema models storage refs at all — gates the "used by" cell. */
    readonly showReferences: boolean;
    readonly t: TFunction;
}

/**
 * One object row. Per-item callbacks come from {@link fileItemBindings} (one stable
 * binding per render, shared with the gallery tile); the copy/delete actions +
 * select checkbox are the shared {@link FileActions} / {@link FileSelect}, so
 * the testids stay identical between list and grid. The name shows relative to
 * the current folder; the full key still scopes everything.
 */
const FileRow = ({ busy, copiedKey, handlers, object, prefix, references, selected, showReferences, t }: FileRowProps): ReactElement => {
    const { copy, download, name, remove, toggle } = fileItemBindings(object, prefix, handlers);

    return (
        <TableRow data-testid="fb-row">
            <TableCell className="w-8">
                <FileSelect objectKey={object.key} onToggle={toggle} selected={selected} t={t} />
            </TableCell>
            <TableCell className="font-mono text-xs">{name}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{formatBytes(object.size)}</TableCell>
            <TableCell>{object.httpMetadata?.contentType ?? ""}</TableCell>
            {showReferences && (
                <TableCell>
                    <FileReferences objectKey={object.key} references={references} t={t} />
                </TableCell>
            )}
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
    /** Rows referencing each object key (via a `v.storage()` column), keyed by key. */
    readonly references: Readonly<Record<string, ReadonlyArray<StorageReference>>>;
    readonly selected: ReadonlySet<string>;
    /** Whether the schema declares any `v.storage()` columns — gates the "used by" column. */
    readonly showReferences: boolean;
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
    references,
    selected,
    showReferences,
    someSelected,
    t,
    toggleSelectAll,
}: FileBrowserListProps): ReactElement => (
    <Card className="overflow-hidden py-0">
        <CardContent className="px-0">
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
                        {showReferences && <TableHead>{t("used by")}</TableHead>}
                        <TableHead aria-label={t("Actions")} />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {folders.map((folder) => (
                        <FolderRow colSpan={showReferences ? 6 : 5} key={folder} name={folder} onEnter={onEnterFolder} />
                    ))}
                    {files.map((object) => (
                        <FileRow
                            busy={busy}
                            copiedKey={copiedKey}
                            handlers={handlers}
                            key={object.key}
                            object={object}
                            prefix={prefix}
                            references={references[object.key]}
                            selected={selected.has(object.key)}
                            showReferences={showReferences}
                            t={t}
                        />
                    ))}
                </TableBody>
            </Table>
        </CardContent>
    </Card>
);

export default FileBrowserList;
