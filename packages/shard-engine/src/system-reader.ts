/**
 * `ctx.db.system` — a best-effort, read-only reader over Lunora's *system*
 * tables.
 *
 * Convex surfaces a handful of read-only system tables (`_scheduled_functions`,
 * `_storage`, ...) through `ctx.db.system`. Lunora mirrors that surface, but with
 * one load-bearing caveat: **the data these tables expose does not live in the
 * shard's SQLite**. Scheduled functions live in the `SchedulerDO`; storage
 * objects live in R2. So unlike `ctx.db.<table>` — which reads the same
 * transactional SQLite snapshot the mutation writes into — `ctx.db.system`
 * reaches across a network/DO boundary on every call.
 *
 * Consequences callers must keep in mind:
 *
 * Asynchronous + eventually consistent: each `collect()` / `get()` issues a fresh
 * read against the backing source. A row a mutation just scheduled may not yet be
 * visible; a job that just fired may still appear pending.
 *
 * NOT part of the transaction snapshot: reading a system table inside a mutation
 * does not pin it; there is no OCC guard and no subscription dependency is
 * recorded. Treat the result as a point-in-time best effort.
 *
 * Read-only: there is no `insert`/`patch`/`delete`. Mutate scheduled jobs via
 * `ctx.scheduler`, storage objects via `ctx.storage`.
 *
 * The reader is intentionally minimal: `query(table).collect()` returns the full
 * list (no indexes, no filtering, no pagination) and `get(table, id)` resolves a
 * single row. That matches Convex's system-table read surface closely enough for
 * the studio / introspection use cases without re-implementing the query
 * planner against a remote source.
 */
import { LunoraError } from "@lunora/errors";

/* eslint-disable unicorn/prevent-abbreviations -- `Doc`/`SystemDoc`/`ScheduledFunctionDoc` are the deliberate public API names for `ctx.db.system` (they mirror Convex's `Doc` naming and the spec the consuming `@lunora/server` types re-export); `doc`/`docs` is the domain term for a stored document throughout the DO ORM (see ctx-db.ts). Renaming would break the documented surface. */

/** The system tables `ctx.db.system` can read. */
type SystemTableName = "_scheduled_functions" | "_storage";

/**
 * A pending scheduled invocation as surfaced by `_scheduled_functions`. A clean
 * mirror of `@lunora/scheduler`'s `ScheduleRecord` / `@lunora/server`'s
 * `ScheduledJob`, re-declared here so this package keeps no dependency on either
 * (matching the structural-mirror convention used throughout `ctx-db.ts`).
 */
interface ScheduledFunctionDoc {
    /** Function arguments the job will be dispatched with. */
    args: Record<string, unknown>;
    /** Number of dispatch attempts already made (absent until the first retry). */
    attempts?: number;
    /** When the job was enqueued (epoch ms). */
    enqueuedAt: number;

    /**
     * Fully-qualified `ns:fn` path of the function to invoke. Absent when the job
     * targets a durable workflow/agent instead — exactly one of `functionPath` /
     * {@link ScheduledFunctionDoc.workflow} is set on any given row.
     */
    functionPath?: string;
    /** The job's id (the `_scheduled_functions` row id). */
    id: string;
    /** Logical workpool the job is concurrency-gated by, when any. */
    pool?: string;
    /** When the job is scheduled to fire (epoch ms). */
    scheduledFor: number;
    /** Routing hint forwarded so dispatch lands on the right shard. */
    shardKey?: string;

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding a fresh durable instance is started from
     * on fire (the {@link ScheduledFunctionDoc.args} become its `params`). Set
     * instead of {@link ScheduledFunctionDoc.functionPath}.
     */
    workflow?: string;
}

/**
 * Per-object metadata as surfaced by `_storage`. Structural mirror of
 * `@lunora/server`'s `StorageMetadata` (which itself mirrors `@lunora/storage`'s
 * `ObjectMetadata`), kept local so this package depends on neither.
 */
interface StorageMetadata {
    /** The object's `Content-Type`, when recorded. */
    contentType?: string;
    /** Custom metadata set at upload time, if any. */
    customMetadata?: Record<string, string>;
    /** The object's key (the `_storage` row id). */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Body length in bytes. */
    size: number;
    /** When the object was last written (epoch ms), when reported. */
    uploaded?: number;
}

/** Maps each system table name to the document shape its reads return. */
interface SystemDocMap {
    _scheduled_functions: ScheduledFunctionDoc;
    _storage: StorageMetadata;
}

/** Document type for a given system table name. */
type SystemDoc<T extends SystemTableName> = SystemDocMap[T];

/** Terminal returned by {@link SystemDatabaseReader.query}; only `.collect()` is supported. */
interface SystemQuery<T extends SystemTableName> {
    /** Resolve the full list of rows in the backing source. */
    collect: () => Promise<SystemDoc<T>[]>;
}

/**
 * Read-only reader over Lunora's system tables. See the module doc for the
 * eventual-consistency / not-in-snapshot caveats — every method is a best-effort
 * async read against the backing source (the `SchedulerDO` for
 * `_scheduled_functions`, R2 for `_storage`), never the shard's SQLite snapshot.
 */
interface SystemDatabaseReader {
    /**
     * Resolve a single system-table row by id, or `null` when absent.
     *
     * - `_scheduled_functions`: the job id.
     * - `_storage`: the object key.
     */
    get: <T extends SystemTableName>(table: T, id: string) => Promise<SystemDoc<T> | null>;

    /**
     * Begin a read over a system table. Call `.collect()` to resolve the full
     * list — there is no filtering or indexing (the backing source is remote;
     * the surface stays deliberately minimal). The backing source may answer in
     * bounded pages; `.collect()` walks all of them, so the caller always sees
     * every row and never a silently truncated prefix.
     */
    query: <T extends SystemTableName>(table: T) => SystemQuery<T>;
}

/**
 * Structural projection of the scheduler surface the system reader needs.
 *
 * Note this is wider than `ctx-db.ts`'s `SchedulerLike` (which only carries
 * `runAfter`/`runAt` for the trigger context): `_scheduled_functions` reads need
 * the `list` / `get` read half. The real `@lunora/scheduler` `Scheduler` and
 * `@lunora/server`'s `Scheduler` both satisfy this.
 */
interface SystemReaderSchedulerLike {
    get: (id: string) => Promise<Record<string, unknown> | null>;
    list: () => Promise<ReadonlyArray<Record<string, unknown>>>;
}

/**
 * Structural projection of the read-only storage surface the system reader
 * needs: `list` to enumerate `_storage`, `getMetadata` for a by-key `get`. The
 * real `@lunora/storage` adapter (and the generated `storageStub`) satisfy this.
 */
interface SystemReaderStorageLike {
    getMetadata: (key: string) => Promise<StorageMetadata | null>;
    list: (prefix?: string, options?: Record<string, unknown>) => Promise<{ objects: ReadonlyArray<Record<string, unknown>> }>;
}

interface SystemReaderOptions {
    /** Backs `_scheduled_functions`. When absent, those reads throw a clear "not configured" error. */
    scheduler?: SystemReaderSchedulerLike;
    /** Backs `_storage`. When absent, those reads throw a clear "not configured" error. */
    storage?: SystemReaderStorageLike;
}

/**
 * Map a scheduler record (shape-compatible with `ScheduleRecord` / `ScheduledJob`)
 * onto the documented {@link ScheduledFunctionDoc}. Reads through `unknown` so a
 * structurally-typed source still maps cleanly. Optional fields are copied only
 * when the record actually carries them — an absent value stays absent rather
 * than being coerced to a placeholder.
 */
const toScheduledFunctionDoc = (record: Record<string, unknown>): ScheduledFunctionDoc => {
    const doc: ScheduledFunctionDoc = {
        args: (record["args"] as Record<string, unknown> | undefined) ?? {},
        enqueuedAt: typeof record["enqueuedAt"] === "number" ? record["enqueuedAt"] : 0,
        id: typeof record["id"] === "string" ? record["id"] : "",
        scheduledFor: typeof record["scheduledFor"] === "number" ? record["scheduledFor"] : 0,
    };

    if (typeof record["attempts"] === "number") {
        doc.attempts = record["attempts"];
    }

    // Copied only when present: a workflow-targeted job has no `functionPath`,
    // and inventing `""` for it made every such row look like a function whose
    // path happened to be empty — a caller matching on the path (a dedupe check
    // before enqueueing) silently never matched and scheduled a duplicate.
    if (typeof record["functionPath"] === "string") {
        doc.functionPath = record["functionPath"];
    }

    if (typeof record["pool"] === "string") {
        doc.pool = record["pool"];
    }

    if (typeof record["shardKey"] === "string") {
        doc.shardKey = record["shardKey"];
    }

    if (typeof record["workflow"] === "string") {
        doc.workflow = record["workflow"];
    }

    return doc;
};

/**
 * Map a storage `list()` object (shape-compatible with `R2ObjectLike` after the
 * adapter's `getMetadata`/`list` normalisation) onto the documented
 * {@link StorageMetadata}. `getMetadata` already returns this shape, so it
 * passes through untouched.
 */
const toStorageMetadata = (object: Record<string, unknown>): StorageMetadata => {
    const meta: StorageMetadata = {
        key: typeof object["key"] === "string" ? object["key"] : "",
        size: typeof object["size"] === "number" ? object["size"] : 0,
    };

    const contentType = (object["httpMetadata"] as { contentType?: string } | undefined)?.contentType ?? object["contentType"];

    if (typeof contentType === "string") {
        meta.contentType = contentType;
    }

    if (object["customMetadata"] && typeof object["customMetadata"] === "object") {
        meta.customMetadata = object["customMetadata"] as Record<string, string>;
    }

    if (typeof object["sha256"] === "string") {
        meta.sha256 = object["sha256"];
    }

    const { uploaded } = object;

    if (typeof uploaded === "number") {
        meta.uploaded = uploaded;
    } else if (uploaded instanceof Date) {
        meta.uploaded = uploaded.getTime();
    }

    return meta;
};

/**
 * Build the read-only {@link SystemDatabaseReader} assigned to `ctx.db.system`.
 * Reads route to the supplied backing sources; an unconfigured source throws a
 * clear `ctx.db.system.<table>: no <source> configured` error (mirroring the
 * generated `storageStub` / `schedulerStub` "no X configured" stubs) rather than
 * silently returning empty — a missing source is a wiring bug, not an empty
 * table.
 */
const createSystemReader = (options: SystemReaderOptions = {}): SystemDatabaseReader => {
    const requireScheduler = (): SystemReaderSchedulerLike => {
        if (!options.scheduler) {
            throw new LunoraError("INTERNAL", 'ctx.db.system.query("_scheduled_functions"): no scheduler configured. Pass `scheduler` to createShardDO().');
        }

        return options.scheduler;
    };

    const requireStorage = (): SystemReaderStorageLike => {
        if (!options.storage) {
            throw new LunoraError("INTERNAL", 'ctx.db.system.query("_storage"): no storage configured. Pass `storage` to createShardDO().');
        }

        return options.storage;
    };

    const collectScheduled = async (): Promise<ScheduledFunctionDoc[]> => {
        const records = await requireScheduler().list();

        return records.map((record) => toScheduledFunctionDoc(record));
    };

    const collectStorage = async (): Promise<StorageMetadata[]> => {
        const { objects } = await requireStorage().list();

        return objects.map((object) => toStorageMetadata(object));
    };

    /**
     * @returns the system query object for the given table
     */
    // Cast (like `get` below) rather than annotate: the per-table branches return
    // concrete `SystemQuery` shapes that TS can't structurally verify against the
    // generic `<T>(table: T) => SystemQuery<T>` signature.
    const queryReader = ((table: SystemTableName) => {
        if (table === "_scheduled_functions") {
            return { collect: collectScheduled };
        }

        return { collect: collectStorage };
    }) as SystemDatabaseReader["query"];

    return {
        get: (async (table: SystemTableName, id: string) => {
            if (table === "_scheduled_functions") {
                const record = await requireScheduler().get(id);

                // eslint-disable-next-line unicorn/no-null -- documented `get()` result shape (Doc | null); null is the "absent" sentinel
                return record ? toScheduledFunctionDoc(record) : null;
            }

            const meta = await requireStorage().getMetadata(id);

            // `getMetadata` already returns the StorageMetadata shape; re-map so a
            // base64 sha256 / Date `uploaded` from a raw source is normalised
            // consistently with the list path.
            // eslint-disable-next-line unicorn/no-null -- documented `get()` result shape (Doc | null); null is the "absent" sentinel
            return meta ? toStorageMetadata(meta as unknown as Record<string, unknown>) : null;
        }) as SystemDatabaseReader["get"],
        query: queryReader,
    };
};

/* eslint-enable unicorn/prevent-abbreviations */

export type {
    ScheduledFunctionDoc,
    StorageMetadata,
    SystemDatabaseReader,
    SystemDoc,
    SystemQuery,
    SystemReaderOptions,
    SystemReaderSchedulerLike,
    SystemReaderStorageLike,
    SystemTableName,
};
export { createSystemReader };
