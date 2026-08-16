import type { JSX } from "react";
import { useCallback } from "react";

interface FileEntry {
    path: string;
    size: number;
    updatedAt: number;
}

interface FileTreeProperties {
    files: ReadonlyArray<FileEntry> | undefined;
    onSelect: (path: string) => void;
    selectedPath: string | undefined;
}

/** One row. Split out so the click handler is per-row and stable, not rebuilt per render of the list. */
const FileRow = ({ file, onSelect, selected }: { file: FileEntry; onSelect: (path: string) => void; selected: boolean }): JSX.Element => {
    const onClick = useCallback(() => {
        onSelect(file.path);
    }, [file.path, onSelect]);

    return (
        <li>
            <button className={selected ? "file-row file-row-selected" : "file-row"} onClick={onClick} type="button">
                <span className="file-path">{file.path}</span>
                <span className="muted">{file.size}</span>
            </button>
        </li>
    );
};

/**
 * The project's files, flat and sorted by path.
 *
 * Flat rather than a folder tree on purpose: a generated project is a few dozen
 * files, sorting by path already groups them by directory, and a collapsible
 * tree is state to manage for no gain at this size. It becomes worth building
 * when a project is big enough that the list stops fitting.
 */
const FileTree = ({ files, onSelect, selectedPath }: FileTreeProperties): JSX.Element => {
    if (files === undefined) {
        return <p className="muted">Loading files…</p>;
    }

    if (files.length === 0) {
        return <p className="muted">No files yet. The builder writes them as it works.</p>;
    }

    const sorted = files.toSorted((left, right) => left.path.localeCompare(right.path));

    return (
        <ul className="file-tree">
            {sorted.map((file) => (
                <FileRow file={file} key={file.path} onSelect={onSelect} selected={file.path === selectedPath} />
            ))}
        </ul>
    );
};

export { FileTree };
