/**
 * Convex export snapshot access — reads table `documents.jsonl` streams and
 * `_storage` blob bytes from either an exploded directory (`npx convex export
 * --path <dir>`) or a `snapshot.zip` archive. Directory exports stay the
 * streaming primary path; the ZIP reader (via `adm-zip`) is the convenience
 * surface and reads entries in full.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import AdmZip from "adm-zip";

/** One `documents.jsonl` file in a Convex export snapshot. */
export interface ConvexSnapshotTable {
    /** Absolute file path (directory) or archive-relative entry (zip). */
    file: string;
    /** Entry path of the table's `_storage` sibling directory (zip only; undefined for directory snapshots). */
    storagePrefix?: string;
    /** Table name (directory / archive entry name). */
    table: string;
}

/**
 * A resolvable Convex export snapshot: an exploded directory or a `.zip`
 * archive (whose layout sits under an `snapshot_<ts>/` root entry).
 *
 * The ZIP variant carries its already-opened {@link AdmZip} reader: the archive
 * central directory is parsed once at resolve time and reused by every accessor,
 * rather than re-parsed per table stream and per blob read.
 */
export type ConvexSnapshot = { kind: "directory"; root: string } | { kind: "zip"; zip: AdmZip; zipPath: string };

/**
 * Resolve the path the import command received to a snapshot, or `undefined`
 * when it is neither a directory nor a `.zip` file.
 */
export const resolveConvexSnapshot = async (
    path: string,
    statImpl: (p: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }> = stat,
): Promise<ConvexSnapshot | undefined> => {
    const info = await statImpl(path).catch(() => undefined);

    if (info?.isDirectory()) {
        return { kind: "directory", root: path };
    }

    if (info?.isFile() && path.toLowerCase().endsWith(".zip")) {
        return { kind: "zip", zip: new AdmZip(path), zipPath: path };
    }

    return undefined;
};

/**
 * Enumerate the `<table>/documents.jsonl` files in a snapshot, sorted by table
 * name for deterministic output. Returns `undefined` when the snapshot is not a
 * Convex export layout.
 */
/* eslint-disable sonarjs/cognitive-complexity -- walks both the directory and archive layouts with distinct enumeration branches */
export const listConvexSnapshotTables = async (snapshot: ConvexSnapshot): Promise<ConvexSnapshotTable[] | undefined> => {
    if (snapshot.kind === "directory") {
        const found: ConvexSnapshotTable[] = [];

        for (const entry of await readdir(snapshot.root, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }

            const file = join(snapshot.root, entry.name, "documents.jsonl");

            // eslint-disable-next-line no-await-in-loop -- one cheap stat per table directory; the set is small
            const documents = await stat(file).catch(() => undefined);

            if (documents?.isFile()) {
                found.push({ file, table: entry.name });
            }
        }

        return found.length > 0 ? found.toSorted((a, b) => a.table.localeCompare(b.table)) : undefined;
    }

    const found: ConvexSnapshotTable[] = [];
    let storagePrefix: string | undefined;

    for (const entry of snapshot.zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }

        const name = entry.entryName.replaceAll("\\", "/");
        const segments = name.split("/");

        if (segments.length < 2 || segments[segments.length - 1] !== "documents.jsonl") {
            continue;
        }

        const table = segments[segments.length - 2] as string;

        if (table === "_storage") {
            storagePrefix = segments.slice(0, -1).join("/");
        }

        found.push({ file: name, table });
    }

    if (found.length === 0) {
        return undefined;
    }

    for (const tableEntry of found) {
        tableEntry.storagePrefix = storagePrefix;
    }

    return found.toSorted((a, b) => a.table.localeCompare(b.table));
};
/* eslint-enable sonarjs/cognitive-complexity */

/** Stream one table's `documents.jsonl` lines as the snapshot provides them. */
export const readSnapshotLines = async function* (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable): AsyncGenerator<string> {
    if (snapshot.kind === "directory") {
        for await (const raw of createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(tableEntry.file, { encoding: "utf8" }) })) {
            yield raw;
        }

        return;
    }

    // eslint-disable-next-line unicorn/prefer-blob-reading-methods -- adm-zip's `readAsText` is not a Blob/FileReader API
    const text = snapshot.zip.readAsText(tableEntry.file);

    for (const line of text.split("\n")) {
        yield line;
    }
};

/**
 * Read one `_storage` blob's bytes. Finds the blob entry under the table's
 * `_storage` directory (zip) or at `_storage/<id>` (directory).
 *
 * `blobId` comes from the export's own `_storage/documents.jsonl`, i.e. from
 * data the operator downloaded rather than authored. A crafted export could put
 * `../` segments in an `_id`, or drop a symlink under `_storage/`, and have the
 * importer read an unrelated local file and upload it to the target bucket — so
 * the resolved path is checked to still live inside the snapshot's `_storage`
 * directory before anything is read.
 */
export const readSnapshotStorageBlob = async (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable, blobId: string): Promise<Buffer> => {
    if (snapshot.kind === "directory") {
        const storageRoot = await realpath(join(snapshot.root, "_storage"));
        const blobPath = await realpath(resolve(storageRoot, blobId)).catch(() => undefined);

        if (blobPath === undefined || (blobPath !== storageRoot && !blobPath.startsWith(storageRoot + sep))) {
            throw new Error(`blob ${blobId} resolves outside the snapshot's _storage directory`);
        }

        return readFile(blobPath);
    }

    const prefix = tableEntry.storagePrefix ?? "_storage";
    const blob = snapshot.zip.readFile(`${prefix}/${blobId}`);

    if (blob === null) {
        throw new Error(`missing blob ${blobId} in archive`);
    }

    return Buffer.from(blob);
};

/** Read a `documents.jsonl` as text (for `_storage` metadata and `--scan`). */
export const readSnapshotText = async (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable): Promise<string> => {
    if (snapshot.kind === "directory") {
        return readFile(tableEntry.file, "utf8");
    }

    // eslint-disable-next-line unicorn/prefer-blob-reading-methods -- adm-zip's `readAsText` is not a Blob/FileReader API
    return snapshot.zip.readAsText(tableEntry.file);
};
