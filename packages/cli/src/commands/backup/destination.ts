/**
 * Where a snapshot backup is kept.
 *
 * One interface, two implementations — a local directory (here) and an R2
 * bucket (`./r2-destination`) — chosen once at the top of each verb. `create`,
 * `list` and `restore` therefore never learn about buckets, and the snapshot
 * encoding never learns where it is going: the export always streams NDJSON to
 * a local path, and the destination decides whether that path _is_ the backup
 * or a staging file on its way somewhere else.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

/** One recorded snapshot. `id` is the ISO timestamp; `file` locates it at its own destination. */
interface BackupManifestEntry {
    bytes: number;
    createdAt: string;
    file: string;
    id: string;
    rows: number;
    /** Lowercase-hex SHA-256 of the snapshot, recorded when it was written. `restore --verify` checks the bytes against it. */
    sha256?: string;
    tables?: string;
}

/** Byte length + checksum of a staged snapshot, computed once by `create` and handed to whichever destination stores it. */
interface SnapshotDigest {
    bytes: number;
    sha256: string;
}

/** A snapshot made readable as a local file, plus whatever the destination itself knows about it. */
interface MaterializedSnapshot {
    /** Local path an import can read. */
    path: string;
    /** Drop any temporary copy made to produce {@link MaterializedSnapshot.path}. */
    release: () => Promise<void>;
}

interface BackupDestination {
    /** Land the staged NDJSON at `file`. Throws unless the bytes are there afterwards. */
    commit: (file: string, stagedPath: string, digest: SnapshotDigest) => Promise<void>;
    /** Human-readable destination, for logs and "nothing found" messages. */
    readonly label: string;
    /** Every recorded snapshot, oldest first. */
    list: () => Promise<BackupManifestEntry[]>;
    /** The `file` to record for a snapshot named `name` — a filename here, an object key in a bucket. */
    locate: (name: string) => string;

    /**
     * Make an existing snapshot readable as a local file. `fromManifest` says
     * whether `file` came from a manifest entry (so it is relative to this
     * destination) or straight from the command line (so it is a path/key the
     * operator typed). `undefined` when there is nothing there.
     */
    materialize: (file: string, fromManifest: boolean) => Promise<MaterializedSnapshot | undefined>;
    /** Add one snapshot to the index. Called only after {@link BackupDestination.commit} succeeded. */
    record: (entry: BackupManifestEntry) => Promise<void>;
    /** Local path the export should stream its NDJSON to. */
    stage: (name: string) => Promise<string>;
}

const MANIFEST_FILE = "manifest.json";

const isManifestEntry = (value: unknown): value is BackupManifestEntry =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as BackupManifestEntry).id === "string" &&
    typeof (value as BackupManifestEntry).file === "string";

/**
 * Byte length + SHA-256 of a file, read as a stream so a multi-GB snapshot is
 * never held in memory just to be hashed. One digest per snapshot, computed by
 * `create` in one place: the manifest records it, the R2 upload declares it,
 * and `restore --verify` compares against it.
 */
const digestFile = async (path: string): Promise<SnapshotDigest> => {
    const hash = createHash("sha256");
    let bytes = 0;

    for await (const chunk of createReadStream(path)) {
        const buffer = chunk as Buffer;

        bytes += buffer.byteLength;
        hash.update(buffer);
    }

    return { bytes, sha256: hash.digest("hex") };
};

/**
 * Read the backup index. A *missing* manifest is fine — start fresh with `[]`.
 * But a manifest that exists yet fails to parse (or isn't an array) is the
 * recovery index the feature exists to protect: throw rather than silently
 * treating it as empty, so the next `backup create` can't overwrite it and
 * destroy the historical index. (`isManifestEntry` still drops malformed
 * entries from an otherwise-valid array — those carry no recoverable id/file).
 */
const readManifest = async (directory: string): Promise<BackupManifestEntry[]> => {
    const path = join(directory, MANIFEST_FILE);

    if (!existsSync(path)) {
        return [];
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        throw new LunoraError("INTERNAL", `backup: ${path} exists but is not valid JSON (${message}) — refusing to overwrite it; fix or remove it manually`, {
            cause: error,
        });
    }

    if (!Array.isArray(parsed)) {
        throw new TypeError(`backup: ${path} exists but is not a JSON array — refusing to overwrite it; fix or remove it manually`);
    }

    return parsed.filter(isManifestEntry);
};

/**
 * Replace the manifest in one step: write a sibling temp file, then rename over
 * the old one. Writing in place truncates first, so a crash or a full disk
 * mid-write leaves an unparseable index — and {@link readManifest} then refuses
 * every later `backup create` rather than clobbering it, which turns one bad
 * write into a stuck backup schedule. The temp file is a sibling so the rename
 * stays within one filesystem, where it is atomic.
 */
const writeManifest = async (directory: string, entries: ReadonlyArray<BackupManifestEntry>): Promise<void> => {
    const temporaryPath = join(directory, `${MANIFEST_FILE}.${randomUUID()}.tmp`);

    try {
        await writeFile(temporaryPath, `${JSON.stringify(entries, undefined, 2)}\n`, "utf8");
        await rename(temporaryPath, join(directory, MANIFEST_FILE));
    } catch (error: unknown) {
        await rm(temporaryPath, { force: true });

        throw error;
    }
};

/**
 * Backups in a local directory: the snapshot is written straight to its final
 * path (staging *is* committing) and the index is a single `manifest.json`
 * beside the snapshots.
 */
const createDirectoryDestination = (directory: string): BackupDestination => {
    return {
        commit: async (): Promise<void> => {
            // The export already wrote the file at its final path — there is
            // nowhere for it to travel to.
        },
        label: directory,
        list: async () => readManifest(directory),
        locate: (name) => name,
        materialize: (file, fromManifest) => {
            const path = fromManifest ? join(directory, file) : file;

            // The snapshot is already a local file — nothing to fetch and
            // nothing to clean up afterwards.
            return Promise.resolve(existsSync(path) ? { path, release: () => Promise.resolve() } : undefined);
        },
        record: async (entry) => {
            const manifest = await readManifest(directory);

            manifest.push(entry);
            await writeManifest(directory, manifest);
        },
        stage: async (name) => {
            await mkdir(directory, { recursive: true });

            return join(directory, name);
        },
    };
};

export type { BackupDestination, BackupManifestEntry, MaterializedSnapshot, SnapshotDigest };
export { createDirectoryDestination, digestFile, isManifestEntry };
