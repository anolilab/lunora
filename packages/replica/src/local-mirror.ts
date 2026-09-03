import { createSqlJsAdapter } from "./adapters/sqljs";
import type { SqliteAdapter } from "./adapters/types";
import { applyDiffToDb as applyDiffToDatabase, escapeIdentifier as escapeIdentifier_ } from "./diff-applier";
import { EventLog } from "./event-log";
import type { TableDiff } from "./table-diff";

/**
 * `MirrorTableDef` is part of the experimental `@lunora/replica` API and may change without a major version bump.
 * @experimental
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API type name
interface MirrorTableDef {
    /** Primary key column name (defaults to `"id"`). */
    readonly primaryKey?: string;
}

/**
 * Options for constructing a {@link LocalMirror}.
 * @experimental
 */
interface LocalMirrorOptions {
    /** Platform-specific SQLite adapter. */
    readonly db: SqliteAdapter;

    /**
     * Cap the mirror's internal {@link EventLog} to this many entries.
     * Every applied diff is recorded in the log, so an uncapped log grows by
     * one entry (holding every changed row) per diff for the life of the
     * mirror — a leak by construction on a long-lived client.
     *
     * Defaults to {@link DEFAULT_MAX_EVENT_LOG_ENTRIES}. On overflow the
     * OLDEST entries are dropped; nothing in the mirror replays its own log,
     * so a drop loses nothing the mirror needs. A consumer that does replay
     * it (`eventLog.getSince(watermark)` from another tab / service worker)
     * detects a gap when the first returned entry's `seq` is above its
     * watermark, and should re-seed from the mirror's rows (`query`) instead
     * of applying the partial window.
     */
    readonly maxEventLogEntries?: number;

    /**
     * Table schemas the mirror should manage.
     *
     * On first use the mirror creates any missing tables automatically
     * based on the columns observed in the first diff/row applied.
     * If you want a fixed schema, pass it here with explicit column
     * definitions in `columns`.
     */
    readonly tables?: Record<string, MirrorTableDef>;
}

// ── LocalMirror ──────────────────────────────────────────────────────────

/** Default {@link LocalMirrorOptions.maxEventLogEntries}. */
const DEFAULT_MAX_EVENT_LOG_ENTRIES = 1000;

// Bookkeeping table for mirror-wide state — currently just the schema
// version (see `MIRROR_SCHEMA_VERSION` below). Created on construction.
const MIRROR_META_TABLE = "__lunora_mirror_meta";

const ensureMetaTable = (database: SqliteAdapter): void => {
    database.exec(
        `CREATE TABLE IF NOT EXISTS ${MIRROR_META_TABLE} (
            key   TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        )`,
    );
};

const SCHEMA_VERSION_META_KEY = "schema_version";

/**
 * Bump this when a change to `#ensureTableSchema`'s type-mapping makes
 * tables created by an older version stale.
 *
 * Version 2: column affinity is inferred from the first observed value
 * (INTEGER/REAL/TEXT) instead of declaring every non-PK column TEXT. TEXT
 * affinity coerces bound integers/reals to text, so `ORDER BY`/comparisons/
 * `SUM`/`AVG` over a numeric column silently returned wrong results on a
 * version-1 mirror. `#reconcileSchemaVersion` drops every mirrored table
 * when the stored version doesn't match this constant, so a stale mirror
 * re-seeds itself (with correct affinities) from the next `applyDiff`
 * instead of staying wrong forever.
 *
 * Version 3: the primary-key column's affinity is now inferred from the
 * first observed id too, instead of always being declared TEXT. A version-2
 * mirror with a numeric primary key sorted and range-filtered it
 * lexicographically (`ORDER BY id` put 10 before 9, `WHERE id > 5` compared
 * strings), so older mirrors re-seed once on next open.
 */
const MIRROR_SCHEMA_VERSION = 3;

/** SQLite column type affinity declared for a mirrored table's column. */
type ColumnAffinity = "INTEGER" | "REAL" | "TEXT";

/**
 * Infer the SQLite column affinity to declare for a diff column from one of
 * its observed (non-null) values.
 *
 * - JS integers and bigints → `INTEGER`.
 * - Non-integer numbers → `REAL`.
 * - Booleans → `INTEGER` (SQLite has no boolean type; `normalizeBindValue`
 * in `diff-applier.ts` binds them as 0/1).
 * - Everything else — strings, and objects/arrays, which
 * `normalizeBindValue` JSON-encodes before binding — declares `TEXT`.
 * A JSON-encoded column therefore reads back as a **string**; callers
 * that stored an object/array must `JSON.parse` it themselves.
 */
const inferColumnAffinity = (value: unknown): ColumnAffinity => {
    if (typeof value === "bigint" || typeof value === "boolean") {
        return "INTEGER";
    }

    if (typeof value === "number") {
        return Number.isInteger(value) ? "INTEGER" : "REAL";
    }

    return "TEXT";
};

/**
 * Local SQLite mirror that maintains a client-side replica of server
 * tables by applying {@link TableDiff} deltas.
 *
 * Usage:
 * ```ts
 * import { createSqlJsAdapter } from "@lunora/replica/adapters/sqljs";
 * import initSqlJs from "sql.js";
 *
 * const SQL = await initSqlJs();
 * const db = createSqlJsAdapter(new SQL.Database());
 *
 * const mirror = new LocalMirror({ db });
 *
 * // Apply a server diff:
 * mirror.applyDiff(someDiff);
 *
 * // Query locally:
 * const rows = mirror.query<{ id: string; name: string }>(
 *   "SELECT id, name FROM users WHERE name LIKE ?",
 *   ["alice%"],
 * );
 * ```
 */
type ChangeSubscriber = () => void;

/**
 * `LocalMirror` is part of the experimental `@lunora/replica` API and may change without a major version bump.
 * @experimental
 */
class LocalMirror {
    readonly #db: SqliteAdapter;
    readonly #tables: Record<string, MirrorTableDef>;
    readonly #eventLog: EventLog;
    readonly #changeListeners = new Set<ChangeSubscriber>();

    /**
     * Monotonically increasing counter bumped on every state-changing
     * operation (`applyDiff`, `clearData`) — independent of `eventLog.size`.
     * `clearData` doesn't grow the log (REPLICA-09), so a consumer that used
     * `eventLog.size` as its `useSyncExternalStore` snapshot would never
     * re-render after a clear; `version` changes on both operations.
     */
    #version = 0;

    /**
     * Convenience factory that creates a {@link LocalMirror} backed by a
     * {@link createSqlJsAdapter sql.js adapter} without needing to import
     * and wire sql.js manually.
     *
     * The caller provides an initialised sql.js database — this method wraps
     * it in an adapter and constructs the mirror.
     * @example
     * ```ts
     * import initSqlJs from "sql.js";
     *
     * const SQL = await initSqlJs();
     * const mirror = LocalMirror.create(new SQL.Database(), {
     *   tables: { todos: { primaryKey: "id" } },
     * });
     * ```
     */
    public static create(
        sqlJsDatabase: {
            close: () => void;
            exec: (sql: string) => { columns: string[]; values: unknown[][] }[];
            run: (sql: string, params?: unknown[]) => void;
        },
        options?: { tables?: Record<string, MirrorTableDef> },
    ): LocalMirror {
        const adapter = createSqlJsAdapter(sqlJsDatabase);

        return new LocalMirror({ db: adapter, tables: options?.tables });
    }

    public constructor(options: LocalMirrorOptions) {
        this.#db = options.db;
        this.#tables = { ...options.tables };
        this.#eventLog = new EventLog({ maxEntries: options.maxEventLogEntries ?? DEFAULT_MAX_EVENT_LOG_ENTRIES });

        ensureMetaTable(this.#db);
        this.#reconcileSchemaVersion();
    }

    /**
     * Subscribe to data-change notifications. Fires after every {@link applyDiff}.
     * Returns an unsubscribe function.
     */
    public onChange(callback: ChangeSubscriber): () => void {
        this.#changeListeners.add(callback);

        return () => {
            this.#changeListeners.delete(callback);
        };
    }

    // ── Public API ─────────────────────────────────────────────────────

    /**
     * The in-memory event log tracking every diff applied to this mirror.
     * Use {@link EventLog.getSince} for catch-up replication across tabs
     * or service-worker instances.
     */
    public get eventLog(): EventLog {
        return this.#eventLog;
    }

    /**
     * The raw SQLite adapter. Advanced consumers (e.g. the React hook)
     * can use it for ad-hoc queries or bulk operations.
     */
    public get db(): SqliteAdapter {
        return this.#db;
    }

    /**
     * Monotonically increasing version counter, bumped on every operation
     * that changes mirrored data (`applyDiff`, `clearData`). Use this — not
     * `eventLog.size` — as a `useSyncExternalStore` snapshot so operations
     * that don't append to the log still trigger a re-render.
     */
    public get version(): number {
        return this.#version;
    }

    /**
     * Apply a server-side diff to the local SQLite mirror.
     *
     * The diff is applied in a transaction and recorded in the event log
     * so other tabs or the SW can catch up.
     */
    public applyDiff(diff: TableDiff): void {
        if (diff.changes.length === 0) {
            return;
        }

        this.#ensureTableSchema(diff);

        applyDiffToDatabase(this.#db, diff, this.primaryKeyOf(diff.table));

        this.#eventLog.append("table-diff", diff, [diff]);
        this.#notifyChange();
    }

    /**
     * Run an arbitrary SQL query against the local mirror and return
     * typed results.
     * @example
     * ```ts
     * const users = mirror.query<{ id: string; name: string }>(
     *   "SELECT id, name FROM users WHERE active = ?",
     *   [true],
     * );
     * ```
     */
    public query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
        return this.#db.query<T>(sql, params);
    }

    /**
     * Delete every row from every data table in the adapter's database
     * (preserves the event log and schema). Useful when re-syncing from scratch.
     *
     * **The mirror owns its database.** The sweep is `sqlite_master` minus the
     * reserved prefixes, NOT {@link LocalMirror.mirroredTables} — a table this
     * mirror never registered is cleared too, and `#reconcileSchemaVersion`
     * DROPs on the same list. It cannot be narrowed to the registered set: that
     * runs from the constructor, before any `applyDiff` has re-registered the
     * tables a previous session persisted, and those are exactly the
     * stale-schema tables it exists to drop. So hand the adapter a database
     * dedicated to the mirror, never one that also holds your own tables.
     *
     * Notifies `onChange` subscribers and bumps {@link LocalMirror.version}
     * (REPLICA-09) even though nothing is appended to the event log — a
     * consumer keyed only on `eventLog.size` would otherwise never learn the
     * mirror was cleared and keep rendering deleted rows.
     */
    public clearData(): void {
        const tables = this.#nonReservedTables();

        this.#db.transaction(() => {
            for (const { name } of tables) {
                this.#db.exec(`DELETE FROM ${escapeIdentifier_(name)}`);
            }
        });

        this.#notifyChange();
    }

    /** Bump {@link LocalMirror.version} and notify `onChange` subscribers (e.g. React hook subscriptions). */
    #notifyChange(): void {
        this.#version += 1;

        for (const listener of this.#changeListeners) {
            try {
                listener();
            } catch {
                // Listener threw — keep notifying others.
            }
        }
    }

    /**
     * Dispose the mirror and close the database connection.
     */
    public close(): void {
        this.#db.close();
        this.#eventLog.clear();
        this.#changeListeners.clear();
    }

    // ── Schema helpers ─────────────────────────────────────────────────

    /**
     * Register a table schema so the mirror can create the table on
     * first use. Merges into any definition already registered for `name`
     * (from the constructor's `tables` or an earlier call), so a helper that
     * registers `{}` just to make the table known does not erase a
     * user-supplied `primaryKey`.
     */
    public registerTable(name: string, definition: MirrorTableDef): void {
        this.#tables[name] = { ...this.#tables[name], ...definition };
    }

    /** The primary-key column of a mirrored table (`"id"` unless registered otherwise). */
    public primaryKeyOf(table: string): string {
        return this.#tables[table]?.primaryKey ?? "id";
    }

    /**
     * Return the list of mirrored table names.
     */
    public get mirroredTables(): ReadonlyArray<string> {
        return Object.keys(this.#tables);
    }

    // ── Internal ───────────────────────────────────────────────────────

    /**
     * List every mirrored data table — i.e. every table in `sqlite_master`
     * EXCLUDING the mirror's own reserved-prefix bookkeeping tables
     * (`__lunora_*`) and SQLite's own (`sqlite_*`).
     *
     * Shared by `clearData` (DELETE the rows) and `#reconcileSchemaVersion`
     * (DROP the tables outright).
     *
     * The `_` wildcard in a LIKE pattern matches any single character, so an
     * unescaped `'__lunora_%'` / `'sqlite_%'` also matches unrelated tables
     * that merely happen to contain "lunora"/"sqlite" at the right offset
     * (e.g. "AAlunoraBdata"), wrongly sweeping them up too. `ESCAPE '\'`
     * makes the `\_` sequences literal underscores.
     */
    #nonReservedTables(): { name: string }[] {
        return this.#db.query<{ name: string }>(
            String.raw`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\_\_lunora\_%' ESCAPE '\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`,
        );
    }

    /**
     * Drop every mirrored data table when the persisted schema version
     * doesn't match {@link MIRROR_SCHEMA_VERSION}, so a mirror created
     * before column-affinity inference (every column declared TEXT) forgets
     * its stale schema and re-seeds itself — with correct affinities — from
     * the next `applyDiff` instead of silently returning wrong numeric
     * comparisons forever.
     *
     * The version lives in the meta table (part of the mirror's persisted
     * identity), so this is a real migration, not a no-op in-memory flag:
     * a brand-new adapter (nothing stored yet) and a stale one (an older
     * version stored) both take the drop path once; a mirror already on the
     * current version returns immediately without touching any table.
     */
    #reconcileSchemaVersion(): void {
        const rows = this.#db.query<{ key: string; value: string }>(`SELECT key, value FROM ${MIRROR_META_TABLE}`);
        const stored = rows.find((row) => row.key === SCHEMA_VERSION_META_KEY)?.value;

        if (stored === String(MIRROR_SCHEMA_VERSION)) {
            return;
        }

        const tables = this.#nonReservedTables();

        this.#db.transaction(() => {
            for (const { name } of tables) {
                this.#db.exec(`DROP TABLE IF EXISTS ${escapeIdentifier_(name)}`);
            }

            this.#db.exec(`INSERT OR REPLACE INTO ${MIRROR_META_TABLE} (key, value) VALUES (?, ?)`, [SCHEMA_VERSION_META_KEY, String(MIRROR_SCHEMA_VERSION)]);
        });
    }

    /**
     * Derive the UNION of non-PK column names across every non-delete change.
     * @param diff The table diff whose changes are scanned.
     * @param pk The primary-key column to exclude from the result.
     */
    static #collectDiffColumns(diff: TableDiff, pk: string): Set<string> {
        const requiredColumns = new Set<string>();

        for (const change of diff.changes) {
            if (change.type === "delete") {
                continue;
            }

            for (const key of Object.keys(change.data)) {
                if (key !== pk) {
                    requiredColumns.add(key);
                }
            }
        }

        return requiredColumns;
    }

    /**
     * Infer the affinity to declare for each of `columns` from the first
     * non-null value observed for that column, in diff order. A column that
     * never carries a non-null value (e.g. every change so far set it to
     * `null`) is left unmapped — callers fall back to `TEXT`.
     * @param diff The table diff whose changes are scanned.
     * @param pk The primary-key column to skip (already declared separately).
     * @param columns The column names to resolve an affinity for.
     */
    static #inferColumnAffinities(diff: TableDiff, pk: string, columns: ReadonlySet<string>): Map<string, ColumnAffinity> {
        const affinities = new Map<string, ColumnAffinity>();

        for (const change of diff.changes) {
            if (change.type === "delete" || affinities.size === columns.size) {
                continue;
            }

            for (const key of columns) {
                if (key === pk || affinities.has(key)) {
                    continue;
                }

                const value = change.data[key];

                if (value === null || value === undefined) {
                    continue;
                }

                affinities.set(key, inferColumnAffinity(value));
            }
        }

        return affinities;
    }

    /**
     * Infer the affinity to declare for the primary-key column from the
     * first non-null id observed in the diff (`data[pk]` on insert/update,
     * `change.id` on delete/update). A diff that never carries an id (e.g.
     * empty data) falls back to `TEXT` — same first-observed-value trade-off
     * as {@link LocalMirror.#inferColumnAffinities}.
     */
    static #inferPkAffinity(diff: TableDiff, pk: string): ColumnAffinity {
        for (const change of diff.changes) {
            const value: unknown = change.type === "delete" ? change.id : change.data[pk];

            if (value !== null && value !== undefined) {
                return inferColumnAffinity(value);
            }

            if (change.type === "update") {
                // data[pk] was absent — the update's own id is the observed pk value.
                return inferColumnAffinity(change.id);
            }
        }

        return "TEXT";
    }

    /**
     * Ensure the target table exists with all columns needed by the diff.
     *
     * - If the table doesn't exist yet, CREATE it with columns derived from the diff data (PK + every non-delete column), each declared with the affinity inferred from its first observed value.
     * - If the table already exists, ALTER TABLE ADD COLUMN for any keys in the diff that don't have a corresponding column yet (schema evolution), with the same inferred affinity.
     */
    #ensureTableSchema(diff: TableDiff): void {
        const pk = this.primaryKeyOf(diff.table);

        // Derive required columns from the UNION of keys across every non-delete change
        const requiredColumns = LocalMirror.#collectDiffColumns(diff, pk);
        const affinities = LocalMirror.#inferColumnAffinities(diff, pk, requiredColumns);

        // Check if the table already exists
        const existing = this.#db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [diff.table]);

        if (existing.length === 0) {
            // Create the table with all required columns. The pk's numeric
            // affinity is declared `INT`, not `INTEGER`: a column typed
            // exactly `INTEGER PRIMARY KEY` becomes SQLite's rowid alias,
            // which accepts integers ONLY — a later non-numeric id for the
            // same table would then raise `datatype mismatch` inside
            // `applyDiffToDatabase`'s transaction and roll back the whole
            // diff, unrelated rows included. `INT` carries the same INTEGER
            // affinity (so ORDER BY/comparisons stay numeric) while still
            // accepting a heterogeneous id.
            const pkAffinity = LocalMirror.#inferPkAffinity(diff, pk);
            let columnDefs = `${escapeIdentifier_(pk)} ${pkAffinity === "INTEGER" ? "INT" : pkAffinity} PRIMARY KEY NOT NULL`;

            for (const key of requiredColumns) {
                columnDefs += `, ${escapeIdentifier_(key)} ${affinities.get(key) ?? "TEXT"}`;
            }

            this.#db.exec(`CREATE TABLE IF NOT EXISTS ${escapeIdentifier_(diff.table)} (${columnDefs})`);
        } else if (requiredColumns.size > 0) {
            // Schema evolution: add any missing columns
            const existingColumns = new Set(this.#db.query<{ name: string }>(`PRAGMA table_info(${escapeIdentifier_(diff.table)})`).map((row) => row.name));

            for (const key of requiredColumns) {
                if (!existingColumns.has(key)) {
                    this.#db.exec(`ALTER TABLE ${escapeIdentifier_(diff.table)} ADD COLUMN ${escapeIdentifier_(key)} ${affinities.get(key) ?? "TEXT"}`);
                }
            }
        }
    }
}

export { LocalMirror };
export type { LocalMirrorOptions, MirrorTableDef };
