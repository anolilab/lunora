/**
 * Where a snapshot backup is kept.
 *
 * One interface, two implementations — a local directory (here) and an R2
 * bucket (`./r2-destination`) — chosen once at the top of each verb. `create`,
 * `list` and `restore` therefore never learn about buckets, and the snapshot
 * encoding never learns where it is going: the export always streams NDJSON to
 * a local path, and the destination decides whether that path _is_ the backup
 * or a staging file on its way somewhere else.
 *
 * The layout itself — key, sidecar suffix, manifest fields, what an `id` is —
 * comes from `@lunora/runtime`'s `backup-layout`, shared with the platform's
 * scheduled backup because both write into the same bucket.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { BackupManifestEntry } from "@lunora/runtime";
import { backupObjectKey, isBackupManifestEntry } from "@lunora/runtime";

/** A snapshot made readable as a local file, plus how to let go of it. */
interface MaterializedSnapshot {
    /** Local path an import can read. */
    path: string;
    /** Drop any temporary copy made to produce {@link MaterializedSnapshot.path}. */
    release: () => Promise<void>;
}

/**
 * Somewhere to write a snapshot that does not exist yet — deliberately not a
 * {@link MaterializedSnapshot}, whose `path` names a file you can read.
 */
interface StagedSnapshot {
    /** Local path the export should stream its NDJSON to. */
    path: string;
    /** Drop whatever staging allocated. A no-op where the staged file is the backup. */
    release: () => Promise<void>;
}

/** Byte length + checksum of a staged snapshot, computed once by `create` and handed to whichever destination stores it. */
interface SnapshotDigest {
    bytes: number;
    sha256: string;
}

interface BackupDestination {
    /**
     * Move the staged NDJSON to where this destination keeps snapshots, and
     * throw if it cannot — a destination that returns normally is promising the
     * bytes are at `file`. Nothing to do where staging already wrote them
     * there.
     */
    commit: (file: string, stagedPath: string, digest: SnapshotDigest) => Promise<void>;
    /** Human-readable destination, for logs and "nothing found" messages. */
    readonly label: string;
    /** Every recorded snapshot, oldest first. */
    list: () => Promise<BackupManifestEntry[]>;
    /** Where a snapshot taken at `id` (an ISO timestamp) lives here — a file name, or an object key. */
    locate: (id: string) => string;

    /**
     * Make an existing snapshot readable as a local file. `entry` is its
     * manifest record when `restore` matched one, in which case the snapshot is
     * wherever this destination put it; with no entry, `target` is a path or key
     * the operator named directly. `undefined` when there is nothing there.
     */
    materialize: (entry: BackupManifestEntry | undefined, target: string) => Promise<MaterializedSnapshot | undefined>;
    /** Add one snapshot to the index. Called only after {@link BackupDestination.commit} succeeded. */
    record: (entry: BackupManifestEntry) => Promise<void>;

    /**
     * Somewhere local for the export to stream its NDJSON to. `release` drops
     * whatever staging allocated — a temp directory for a remote destination,
     * nothing for a local one — and `create` calls it however the run ends, so
     * a failed export cannot leave a copy of production behind.
     */
    stage: (id: string) => Promise<StagedSnapshot>;
}

const MANIFEST_FILE = "manifest.json";

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
 * destroy the historical index. (`isBackupManifestEntry` still drops
 * malformed entries from an otherwise-valid array — those carry no recoverable
 * id/file).
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

    return parsed.filter((entry): entry is BackupManifestEntry => isBackupManifestEntry(entry));
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
 * Resolve a manifest entry's `file` inside the backup directory, refusing
 * anything that escapes it.
 *
 * A manifest is data, and `file` is a path taken from it: `"../../../etc/hosts"`
 * or an absolute path would otherwise make `restore <id>` read and import a file
 * from anywhere on disk. The shape guard that accepted the entry only knows it
 * is a string — a shape check is not a safety check, and it is shared with
 * retention, which compares object keys where path semantics do not apply.
 *
 * Compared with a separator, not by raw prefix: `/backups-evil/x` starts with
 * `/backups` and is not inside it.
 */
const resolveInsideDirectory = (directory: string, entry: BackupManifestEntry): string => {
    const root = resolve(directory);
    const path = resolve(root, entry.file);

    if (path !== root && !path.startsWith(`${root}${sep}`)) {
        throw new LunoraError("INTERNAL", `backup: entry ${entry.id} points outside ${root} (${entry.file}) — refusing to read it`);
    }

    return path;
};

/**
 * Backups in a local directory: snapshots and a single `manifest.json` index
 * beside them.
 */
const createDirectoryDestination = (directory: string): BackupDestination => {
    const locate = (id: string): string => backupObjectKey("", id);

    return {
        commit: async (file, stagedPath) => {
            // Rename within the directory — atomic, so `manifest.json` never
            // names a file that is half-written.
            await rename(stagedPath, join(directory, file));
        },
        label: directory,
        list: async () => readManifest(directory),
        locate,
        materialize: (entry, target) => {
            // With no entry, `target` is a path the operator typed, and naming
            // any file they can read is the point of that form.
            const path = entry === undefined ? target : resolveInsideDirectory(directory, entry);

            // The snapshot is already a local file — nothing to fetch and
            // nothing to clean up afterwards.
            return Promise.resolve(existsSync(path) ? { path, release: () => Promise.resolve() } : undefined);
        },
        record: async (entry) => {
            const manifest = await readManifest(directory);

            manifest.push(entry);
            await writeManifest(directory, manifest);
        },
        stage: async (id) => {
            await mkdir(directory, { recursive: true });

            // Staged under a temporary name in the same directory, so a failed
            // export/digest/commit leaves nothing behind that `list` cannot see:
            // a partial `.ndjson` with no manifest entry is invisible and
            // accumulates. `commit` renames it into place; `release` removes it
            // if it is still there.
            const path = join(directory, `${locate(id)}.${randomUUID()}.partial`);

            return { path, release: () => rm(path, { force: true }) };
        },
    };
};

export type { BackupDestination };
export { createDirectoryDestination, digestFile };
