/**
 * The storage-reference rewrite: turning a Convex storage id into the
 * content-hash R2 key its blob was migrated to.
 *
 * Split out of `./storage-mapping` (which owns the mapping *file*) because it
 * has two callers that must never diverge — the import rewrite and `--scan`,
 * which runs this same walk as a dry run to propose the mapping. A detector
 * that proposed columns the rewrite would not touch, or missed ones it would,
 * is worse than no detector.
 */

/** One reference the walk could not rewrite, with where it was found. */
interface UnresolvedStorageReference {
    column: string;
    storageId: string;
    table: string;
}

/**
 * What a run's storage references resolved to. The two failure buckets are
 * deliberately separate, because they are not the same problem and do not have
 * the same remedy:
 *
 * `unmigrated` is a reference to a blob that does not exist — the export omitted
 * it, or `--include-file-storage` was not passed. Nothing the operator writes in
 * a mapping file can fix it, and the data is broken after import, so it fails
 * `--verify`.
 *
 * `ambiguous` is a string that exactly matches a blob that *did* migrate, sitting
 * in a column the mapping does not name. It may be a storage reference the
 * mapping forgot, or it may be user text that happens to equal an id. Failing the
 * run on a coincidence is not defensible, so it warns and names the column the
 * operator would add to resolve it.
 */
interface StorageRemapReport {
    ambiguous: UnresolvedStorageReference[];
    /** Number of references rewritten to a content-hash key. */
    rewritten: number;
    unmigrated: UnresolvedStorageReference[];
}

/**
 * Rewrite storage references in one document against the `storageId → key` map,
 * returning the rewritten document plus what the walk found.
 *
 * `{ $storage: id }` objects are Convex's self-describing Storage value. They are
 * unambiguous, so they are rewritten wherever they occur, at any depth. A plain
 * string is ambiguous against ordinary text, so it is rewritten only under a
 * column `lunora/import-convex.json` names — with no mapping file, no plain
 * string is rewritten at all.
 *
 * The walk is recursive because Convex documents nest freely: a storage id in an
 * array of attachments or inside a nested object is exactly as load-bearing as a
 * top-level one, and skipping it leaves a reference that resolves to nothing
 * while the import still reports success. The **top-level** column name travels
 * down with the walk, so listing `attachments` in the mapping covers every
 * storage id underneath it. That is what makes the mapping a complete answer:
 * `storageColumns` cannot address a nested path, so a nested-only rule would
 * report references the operator had no way to resolve.
 */
const remapStorageReferences = (
    document_: Record<string, unknown>,
    storageIdMap: Map<string, string>,
    table: string,
    storageColumns?: Record<string, string[]>,
): StorageRemapReport & { document: Record<string, unknown> } => {
    const ambiguous: UnresolvedStorageReference[] = [];
    const unmigrated: UnresolvedStorageReference[] = [];
    let rewritten = 0;

    /**
     * Only a column the mapping names. With no mapping file, no plain string is
     * rewritten at all — the operator runs `--scan` to opt columns in. The
     * alternative (treat a missing file as "rewrite everything") inverts the
     * semantics: adding a file would make rewriting *less* aggressive, and
     * deleting a false-positive column from a reviewed mapping would silently
     * restore the rewrite it was deleted to prevent.
     */
    const isMappedColumn = (column: string): boolean => storageColumns?.[table]?.includes(column) === true;

    const remapValue = (value: unknown, column: string, topLevel = false): unknown => {
        if (Array.isArray(value)) {
            return value.map((entry) => remapValue(entry, column, topLevel));
        }

        if (value !== null && typeof value === "object") {
            const record = value as Record<string, unknown>;

            if (typeof record["$storage"] === "string") {
                const storageId = record["$storage"];
                const mappedKey = storageIdMap.get(storageId);

                if (mappedKey === undefined) {
                    unmigrated.push({ column, storageId, table });

                    return value;
                }

                rewritten += 1;

                return mappedKey;
            }

            return Object.fromEntries(Object.entries(record).map(([nested, entry]) => [nested, remapValue(entry, column)]));
        }

        if (typeof value === "string" && storageIdMap.has(value)) {
            if (!isMappedColumn(column)) {
                ambiguous.push({ column, storageId: value, table });

                return value;
            }

            rewritten += 1;

            return storageIdMap.get(value) ?? value;
        }

        // A string in a column the operator DECLARED to hold storage ids, which
        // resolves to no migrated blob — the blob was deleted between the last
        // write and the export, or the export omitted it. The self-describing
        // form gets this check; the declared column is the one the mapping file
        // exists to serve, so it needs it more.
        //
        // Only at the top level: the walk descends into mapped object columns,
        // and flagging every unresolvable string underneath one would bury the
        // real finding in noise. `storageColumns` addresses columns, so that is
        // the depth it can speak about.
        if (topLevel && typeof value === "string" && value.length > 0 && isMappedColumn(column) && storageColumns !== undefined) {
            unmigrated.push({ column, storageId: value, table });
        }

        return value;
    };

    const document = Object.fromEntries(Object.entries(document_).map(([column, value]) => [column, remapValue(value, column, true)]));

    return { ambiguous, document, rewritten, unmigrated };
};

export type { StorageRemapReport, UnresolvedStorageReference };
export { remapStorageReferences };
