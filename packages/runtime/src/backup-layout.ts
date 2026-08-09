/**
 * How a snapshot backup is laid out in an object store — the one definition
 * both writers use.
 *
 * Two of them exist: the platform's scheduled backup (`backupCron` /
 * `backupStore`, in `./scheduled-backup`) and `lunora backup create --bucket`
 * in `@lunora/cli`. They deliberately share a bucket so an operator sees one
 * history, which means they must agree on the key, the sidecar suffix, the
 * manifest fields and what an `id` is. Written out twice, those four rules
 * would drift the first time one side changed — this file is what makes
 * "they agree" a type error rather than a comment.
 *
 * Zero dependencies and no I/O, so the CLI can import it without pulling a
 * Worker runtime into its bundle.
 */

/** Default key prefix backups live under. Both writers default here so one bucket is one history. */
const BACKUP_KEY_PREFIX = "backups/";

/**
 * A prefix is a key prefix, not a directory, but everyone types it like one.
 * Without this, `--prefix backups` / `backupPrefix: "backups"` yields
 * `backupslunora-backup-…`: a key that works, sorts oddly, and matches nothing
 * the other writer produced. Idempotent, and `""` stays `""` so the same
 * builder can produce a bare file name.
 */
const normalizeBackupPrefix = (prefix: string): string => (prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`);

/** Suffix of the per-snapshot manifest sidecar, written beside the snapshot it describes. */
const BACKUP_MANIFEST_SUFFIX = ".manifest.json";

/**
 * The object key (or file name, with an empty `prefix`) for the snapshot taken
 * at `id`.
 *
 * `id` is the ISO timestamp — `2026-06-01T12:00:00.000Z` — and stays that way
 * in the manifest, because it is what `lunora backup restore <id>` matches on.
 * Only the key swaps `:` and `.` for `-`, since both are awkward in file names
 * and object keys. Conflating the two forms is why `restore` used to be
 * documented with an argument it could never match.
 */
const backupObjectKey = (prefix: string, id: string): string => `${normalizeBackupPrefix(prefix)}lunora-backup-${id.replaceAll(/[.:]/gu, "-")}.ndjson`;

/** The sidecar key for a snapshot at `objectKey`. */
const backupManifestKey = (objectKey: string): string => `${objectKey}${BACKUP_MANIFEST_SUFFIX}`;

/** Is this the sidecar of a snapshot, rather than the snapshot itself? */
const isBackupManifestKey = (key: string): boolean => key.endsWith(BACKUP_MANIFEST_SUFFIX);

/** The snapshot key a sidecar describes — the inverse of {@link backupManifestKey}. */
const backupObjectKeyOfManifest = (manifestKey: string): string => manifestKey.slice(0, -BACKUP_MANIFEST_SUFFIX.length);

/**
 * What every snapshot records about itself, whichever writer took it.
 *
 * `id` is the ISO timestamp the snapshot was taken at and the handle `restore`
 * resolves; `file` is where it lives at its own destination (a file name in a
 * directory, an object key in a bucket).
 */
interface BackupManifestEntry {
    /** Byte length of the snapshot as stored. */
    bytes: number;
    createdAt: string;
    file: string;
    id: string;
    rows: number;

    /**
     * Lowercase-hex SHA-256 of the snapshot. Optional only because snapshots
     * taken before checksums existed have none — `restore --verify` refuses
     * those rather than reporting an unverified restore as a verified one.
     */
    sha256?: string;
    /** The `--tables` / `backupTables` allowlist, when the snapshot is a subset. */
    tables?: string;
}

/**
 * Is this a backup manifest? The shape check both sides need: the reader, to
 * skip an unrelated object under the prefix, and retention, to decide whether
 * something is safe to delete. The side that deletes must not be the side
 * without a guard.
 */
const isBackupManifestEntry = (value: unknown): value is BackupManifestEntry =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as BackupManifestEntry).id === "string" &&
    typeof (value as BackupManifestEntry).file === "string";

export type { BackupManifestEntry };
export { BACKUP_KEY_PREFIX, backupManifestKey, backupObjectKey, backupObjectKeyOfManifest, isBackupManifestEntry, isBackupManifestKey, normalizeBackupPrefix };
