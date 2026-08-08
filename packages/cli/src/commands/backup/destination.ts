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
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

/** One recorded snapshot. `id` is the ISO timestamp; `file` locates it at its own destination. */
interface BackupManifestEntry {
    bytes: number;
    createdAt: string;
    file: string;
    id: string;
    rows: number;
    tables?: string;
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
    commit: (file: string, stagedPath: string) => Promise<void>;
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
            await writeFile(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
        },
        stage: async (name) => {
            await mkdir(directory, { recursive: true });

            return join(directory, name);
        },
    };
};

export type { BackupDestination, BackupManifestEntry, MaterializedSnapshot };
export { createDirectoryDestination, isManifestEntry, MANIFEST_FILE };
