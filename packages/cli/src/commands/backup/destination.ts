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
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { BackupManifestEntry } from "@lunora/runtime";
import { backupObjectKey, isBackupManifestEntry } from "@lunora/runtime";

import isInsideDirectory from "../../util/path-containment";

/**
 * A local path this destination has handed out, and how to let go of it.
 *
 * Used in both directions — a snapshot staged for writing, and one materialised
 * for reading — because the caller's obligation is identical either way: use
 * `path`, then call `release` however the run ends. They are one type rather
 * than two because TypeScript is structural, so a "staged vs materialised"
 * distinction would be documentation the compiler does not enforce.
 */
interface SnapshotFile {
    /** Local path to write to, or to read from. */
    path: string;

    /**
     * Release whatever the destination allocated to produce {@link SnapshotFile.path}.
     * Always call it; never assume it does nothing.
     */
    release: () => Promise<void>;
}

/** Byte length + checksum of a staged snapshot, computed once by `create` and handed to whichever destination stores it. */
interface SnapshotDigest {
    bytes: number;
    sha256: string;
}

/**
 * Where a destination keeps snapshots, as a contract rather than a description
 * of any one implementation.
 *
 * What a caller may rely on. `stage` hands back a path to write to and a
 * `release` that must be called however the run ends, including on failure;
 * staging is never the final location, so an abandoned run leaves nothing an
 * operator has to find. `commit` is what makes a snapshot exist at `file` —
 * before it returns successfully, nothing may assume the snapshot is there.
 * `record` is called only after `commit` succeeded, so the index never names a
 * snapshot that was not written.
 *
 * Implementations differ in how much work each step is, not in whether it
 * happens — an implementation whose `commit` or `release` does nothing is a bug
 * (it was one: staging straight to the final path left partial snapshots in the
 * operator's directory).
 */
interface BackupDestination {
    /**
     * Move the staged NDJSON to where this destination keeps snapshots, and
     * throw if it cannot. Returning normally promises the bytes are at `file`.
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
    materialize: (entry: BackupManifestEntry | undefined, target: string) => Promise<SnapshotFile | undefined>;
    /** Add one snapshot to the index. Called only after {@link BackupDestination.commit} succeeded. */
    record: (entry: BackupManifestEntry) => Promise<void>;

    /**
     * Somewhere local for the export to stream its NDJSON to, never the final
     * location. `release` drops it, and `create` calls that however the run
     * ends, so a failed export cannot leave a copy of production behind.
     */
    stage: (id: string) => Promise<SnapshotFile>;
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
 * anything that escapes it. `undefined` when there is simply no such file.
 *
 * A manifest is data, and `file` is a path taken from it: `"../../../etc/hosts"`
 * or an absolute path would otherwise make `restore <id>` read and import a file
 * from anywhere on disk. The shape guard that accepted the entry only knows it
 * is a string — a shape check is not a safety check, and it is shared with
 * retention, which compares object keys where path semantics do not apply.
 *
 * Two checks, because they catch different things. `resolve` normalises text
 * against the working directory and never inspects the filesystem, so it closes
 * `../` and absolute paths — including for a file that does not exist, which is
 * still an attack signal worth naming — and is blind to a symlink sitting inside
 * the directory that points out of it. `realpath` is what asks the filesystem,
 * on BOTH sides: a backup directory can itself sit behind a symlink (`/home` →
 * `/mnt/home` on plenty of installs; every macOS temp directory, which is how
 * the test suite catches it), so canonicalising only the candidate rejects
 * legitimate paths.
 *
 * Order matters: `realpath` throws on a missing path, and a missing snapshot is
 * ordinary — "not found" and "escaped" must not collapse into one answer.
 */
const resolveInsideDirectory = async (directory: string, entry: BackupManifestEntry): Promise<string | undefined> => {
    const lexicalRoot = resolve(directory);
    const lexicalPath = resolve(lexicalRoot, entry.file);
    const refuse = (): never => {
        throw new LunoraError("INTERNAL", `backup: entry ${entry.id} points outside ${lexicalRoot} (${entry.file}) — refusing to read it`);
    };

    if (!isInsideDirectory(lexicalRoot, lexicalPath)) {
        refuse();
    }

    if (!existsSync(lexicalPath)) {
        return undefined;
    }

    if (!isInsideDirectory(await realpath(lexicalRoot), await realpath(lexicalPath))) {
        refuse();
    }

    return lexicalPath;
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
        materialize: async (entry, target) => {
            // With no entry, `target` is a path the operator typed, and naming
            // any file they can read is the point of that form — so it is
            // checked for existence and nothing else. The entry branch has both
            // checks inside `resolveInsideDirectory`.
            const found = (path: string | undefined): SnapshotFile | undefined => (path === undefined ? undefined : { path, release: () => Promise.resolve() });

            if (entry === undefined) {
                return found(existsSync(target) ? target : undefined);
            }

            // The snapshot is already a local file — nothing to fetch and
            // nothing to clean up afterwards.
            return found(await resolveInsideDirectory(directory, entry));
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

export type { BackupDestination, SnapshotFile };
export { createDirectoryDestination, digestFile };
