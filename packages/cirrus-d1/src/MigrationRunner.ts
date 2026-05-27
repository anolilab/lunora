import type { D1DatabaseLike } from "./D1Client.js";

export interface Migration {
    /** Monotonically increasing integer used to order and dedupe migrations. */
    version: number;
    /** Human-readable name, e.g. `001_init` (used in logs). */
    name: string;
    /** Raw SQL to apply. Should be idempotent where possible. */
    sql: string;
}

const TRACKING_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS _cirrus_migrations (
        version  INTEGER PRIMARY KEY,
        name     TEXT    NOT NULL,
        applied_at TEXT  NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`;

export interface MigrationRunnerResult {
    applied: { version: number; name: string }[];
    skipped: { version: number; name: string }[];
}

/**
 * Sequentially applies pending migrations against a D1 database. Applied
 * versions are tracked in the `_cirrus_migrations` table.
 */
export class MigrationRunner {
    private readonly db: D1DatabaseLike;

    private readonly migrations: Migration[];

    constructor(db: D1DatabaseLike, migrations: Migration[]) {
        this.db = db;
        // Defensive: ensure callers can't accidentally feed us out-of-order versions.
        this.migrations = [...migrations].sort((a, b) => a.version - b.version);
        this.assertUniqueVersions();
    }

    public async run(): Promise<MigrationRunnerResult> {
        await this.db.prepare(TRACKING_TABLE_SQL).run();

        const appliedRows = await this.db
            .prepare("SELECT version FROM _cirrus_migrations")
            .all<{ version: number }>();
        const appliedVersions = new Set((appliedRows.results ?? []).map((row) => row.version));

        const applied: { version: number; name: string }[] = [];
        const skipped: { version: number; name: string }[] = [];

        for (const migration of this.migrations) {
            if (appliedVersions.has(migration.version)) {
                skipped.push({ version: migration.version, name: migration.name });

                continue;
            }

            await this.applyOne(migration);
            applied.push({ version: migration.version, name: migration.name });
        }

        return { applied, skipped };
    }

    private async applyOne(migration: Migration): Promise<void> {
        // D1 lacks user-level BEGIN/COMMIT, but `batch` runs statements
        // atomically. Split on `;` boundaries that aren't trivially empty.
        const statements = migration.sql
            .split(/;\s*(?:\r?\n|$)/u)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .map((stmt) => this.db.prepare(stmt));

        statements.push(
            this.db
                .prepare("INSERT INTO _cirrus_migrations (version, name) VALUES (?, ?)")
                .bind(migration.version, migration.name),
        );

        if (this.db.batch) {
            await this.db.batch(statements);

            return;
        }

        for (const stmt of statements) {
            await stmt.run();
        }
    }

    private assertUniqueVersions(): void {
        const seen = new Set<number>();

        for (const m of this.migrations) {
            if (seen.has(m.version)) {
                throw new Error(`Duplicate migration version ${m.version}`);
            }

            seen.add(m.version);
        }
    }
}
