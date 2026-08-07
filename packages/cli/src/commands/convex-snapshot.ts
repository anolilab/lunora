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

import openZipEntryStream from "./zip-entry-stream";

/**
 * Convex's own file table. Its rows describe stored BLOBS, not application
 * data — the bytes sit next to the JSONL as separate files and belong in R2,
 * so importing the rows alone would create dangling references.
 */
const CONVEX_STORAGE_TABLE = "_storage";

/**
 * Convex system tables are `_`-prefixed (`_storage`, `_scheduled_functions`,
 * `_modules`, …). None of them are application data, and none of them exist on
 * the target: streaming them in would create rows nothing reads, and `--verify`
 * would then demand row parity for a table the endpoint rejected.
 */
const isConvexSystemTable = (table: string): boolean => table.startsWith("_");

/** One `documents.jsonl` file in a Convex export snapshot. */
interface ConvexSnapshotTable {
    /** Absolute file path (directory) or archive-relative entry (zip). */
    file: string;
    /** Table name (directory / archive entry name). */
    table: string;
}

/**
 * A resolvable Convex export snapshot: an exploded directory or a `.zip`
 * archive (whose layout sits under a `snapshot_<ts>/` root entry).
 *
 * The ZIP variant carries its already-opened {@link AdmZip} reader, so the
 * archive's central directory is parsed once at resolve time rather than per
 * table stream and per blob read. `storagePrefix` lives here rather than on a
 * table because it describes the archive's layout, not any one table.
 */
type ConvexSnapshot = { kind: "directory"; root: string } | { kind: "zip"; storagePrefix: string; zip: AdmZip; zipPath: string };

/**
 * Locate the archive's `_storage` directory. The export roots everything under
 * `snapshot_<ts>/`, so the prefix is only knowable by looking, and it is worth
 * looking once at resolve time rather than per blob read.
 */
const findZipStoragePrefix = (zip: AdmZip): string => {
    for (const entry of zip.getEntries()) {
        const name = entry.entryName.replaceAll("\\", "/");
        const segments = name.split("/");

        if (segments.length >= 2 && segments[segments.length - 2] === "_storage") {
            return segments.slice(0, -1).join("/");
        }
    }

    return "_storage";
};

/**
 * Resolve the path the import command received to a snapshot, or `undefined`
 * when it is neither a directory nor a `.zip` file.
 */
const resolveConvexSnapshot = async (path: string): Promise<ConvexSnapshot | undefined> => {
    const info = await stat(path).catch(() => undefined);

    if (info?.isDirectory()) {
        return { kind: "directory", root: path };
    }

    if (info?.isFile() && path.toLowerCase().endsWith(".zip")) {
        const zip = new AdmZip(path);

        return { kind: "zip", storagePrefix: findZipStoragePrefix(zip), zip, zipPath: path };
    }

    return undefined;
};

/** Enumerate `<table>/documents.jsonl` under an exploded export directory. */
const listDirectoryTables = async (root: string): Promise<ConvexSnapshotTable[]> => {
    const found: ConvexSnapshotTable[] = [];

    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        const file = join(root, entry.name, "documents.jsonl");

        // eslint-disable-next-line no-await-in-loop -- one cheap stat per table directory; the set is small
        const documents = await stat(file).catch(() => undefined);

        if (documents?.isFile()) {
            found.push({ file, table: entry.name });
        }
    }

    return found;
};

/** Enumerate every `documents.jsonl` entry inside the archive. */
const listZipTables = (zip: AdmZip): ConvexSnapshotTable[] => {
    const found: ConvexSnapshotTable[] = [];

    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }

        const name = entry.entryName.replaceAll("\\", "/");
        const segments = name.split("/");

        if (segments.length >= 2 && segments[segments.length - 1] === "documents.jsonl") {
            found.push({ file: name, table: segments[segments.length - 2] as string });
        }
    }

    return found;
};

/**
 * Enumerate the `<table>/documents.jsonl` files in a snapshot, sorted by table
 * name for deterministic output. Returns `undefined` when the snapshot is not a
 * Convex export layout.
 */
const listConvexSnapshotTables = async (snapshot: ConvexSnapshot): Promise<ConvexSnapshotTable[] | undefined> => {
    const found = snapshot.kind === "directory" ? await listDirectoryTables(snapshot.root) : listZipTables(snapshot.zip);

    return found.length > 0 ? found.toSorted((a, b) => a.table.localeCompare(b.table)) : undefined;
};

/** Stream one table's `documents.jsonl` lines as the snapshot provides them. */
const readSnapshotLines = async function* (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable): AsyncGenerator<string> {
    if (snapshot.kind === "directory") {
        for await (const raw of createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(tableEntry.file, { encoding: "utf8" }) })) {
            yield raw;
        }

        return;
    }

    const entry = snapshot.zip.getEntry(tableEntry.file);

    if (entry === null) {
        throw new Error(`missing ${tableEntry.file} in archive`);
    }

    // Streamed rather than `readAsText`-ed: a table's `documents.jsonl` is
    // unbounded, and inflating one whole into a string (then splitting it into
    // an array of every line) is how a large snapshot runs the CLI out of
    // memory on the ZIP path while the identical directory import succeeds.
    const stream = await openZipEntryStream(snapshot.zipPath, entry);

    if (stream === undefined) {
        return;
    }

    const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

    try {
        for await (const raw of lines) {
            yield raw;
        }
    } finally {
        // A consumer that stops early — `break`, a throw, or an import that
        // fails on row 12 of a million — leaves the readline interface and the
        // ZIP entry stream open otherwise, holding the archive's file handle
        // for the rest of the process.
        lines.close();
        stream.destroy();
    }
};

/**
 * Read one `_storage` blob's bytes, from `_storage/<id>` (directory) or the
 * archive's `_storage` entry (zip).
 *
 * `blobId` comes from the export's own `_storage/documents.jsonl`, i.e. from
 * data the operator downloaded rather than authored. A crafted export could put
 * `../` segments in an `_id`, or drop a symlink under `_storage/`, and have the
 * importer read an unrelated local file and upload it to the target bucket — so
 * the resolved path is checked to still live inside the snapshot's `_storage`
 * directory before anything is read.
 */
const readSnapshotStorageBlob = async (snapshot: ConvexSnapshot, blobId: string): Promise<Buffer> => {
    if (snapshot.kind === "directory") {
        const storageRoot = await realpath(join(snapshot.root, "_storage"));
        const blobPath = await realpath(resolve(storageRoot, blobId)).catch(() => undefined);

        if (blobPath === undefined || (blobPath !== storageRoot && !blobPath.startsWith(storageRoot + sep))) {
            throw new Error(`blob ${blobId} resolves outside the snapshot's _storage directory`);
        }

        return readFile(blobPath);
    }

    const blob = snapshot.zip.readFile(`${snapshot.storagePrefix}/${blobId}`);

    if (blob === null) {
        throw new Error(`missing blob ${blobId} in archive`);
    }

    return Buffer.from(blob);
};

export type { ConvexSnapshot, ConvexSnapshotTable };
export { CONVEX_STORAGE_TABLE, isConvexSystemTable, listConvexSnapshotTables, readSnapshotLines, readSnapshotStorageBlob, resolveConvexSnapshot };
