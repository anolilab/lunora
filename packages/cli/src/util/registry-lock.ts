/**
 * Per-project lock for `lunora add` whole-file items, persisted at
 * `lunora/.lunora-registry.json`.
 *
 * It records, per item, the SHA-256 of each whole-file destination **as `add`
 * last wrote it**. That recorded hash is the "base" in a 3-way reconcile on
 * re-run: comparing it against the file currently on disk ("yours") and the
 * incoming registry copy ("theirs") lets `add` distinguish a clean upgrade
 * (user hasn't touched the file → safe to overwrite) from a real conflict (user
 * edited it → never clobber; drop a `.new` sidecar instead).
 *
 * Schema-extension merges are NOT tracked here — they carry their own
 * `lunora:add` managed-block markers in `schema.ts` and are idempotent on their
 * own (see `insert-schema-extension.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";

/** Current on-disk lock format version. */
const LOCK_VERSION = 1 as const;

/** The lock file's name, relative to the project's `lunora/` directory. */
const LOCK_FILE = ".lunora-registry.json";

/** One item's recorded state: a map of destination path (relative to project root) → last-written content hash. */
interface LockItem {
    files: Record<string, string>;
}

interface RegistryLock {
    items: Record<string, LockItem>;
    version: typeof LOCK_VERSION;
}

/** Absolute path to the lock file for a project root. */
const lockPath = (projectRoot: string): string => join(projectRoot, "lunora", LOCK_FILE);

/** Structural guard for a parsed lock: an object carrying a non-null `items` object. */
const isLockShape = (value: unknown): value is { items: Record<string, LockItem> } => {
    if (typeof value !== "object" || value === null || !("items" in value)) {
        return false;
    }

    return typeof value.items === "object" && value.items !== null;
};

/** SHA-256 (hex) of a file's text content — the unit of comparison for the 3-way reconcile. */
const hashContent = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Read the lock, returning an empty lock when absent or malformed (never throws on a bad file). */
const readLock = (projectRoot: string): RegistryLock => {
    const path = lockPath(projectRoot);

    if (!existsSync(path)) {
        return { items: {}, version: LOCK_VERSION };
    }

    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

        if (isLockShape(parsed)) {
            return { items: parsed.items, version: LOCK_VERSION };
        }
    } catch {
        // Fall through to a fresh lock — a corrupt lock shouldn't wedge `add`.
    }

    return { items: {}, version: LOCK_VERSION };
};

/** Persist the lock (pretty-printed, trailing newline). */
const writeLock = (projectRoot: string, lock: RegistryLock): void => {
    writeFileSync(lockPath(projectRoot), `${JSON.stringify(lock, undefined, 2)}\n`, "utf8");
};

/** Record (or overwrite) the last-written hash for one item's destination file. */
const recordFile = (lock: RegistryLock, itemKey: string, destinationRelative: string, content: string): void => {
    const item = lock.items[itemKey] ?? { files: {} };

    // eslint-disable-next-line no-param-reassign -- `lock` is the accumulator this helper exists to populate
    lock.items[itemKey] = item;
    item.files[destinationRelative] = hashContent(content);
};

/** The hash `add` last recorded for a destination, or `undefined` if it was never tracked. */
const recordedHash = (lock: RegistryLock, itemKey: string, destinationRelative: string): string | undefined => lock.items[itemKey]?.files[destinationRelative];

export type { LockItem, RegistryLock };
export { hashContent, readLock, recordedHash, recordFile, writeLock };
