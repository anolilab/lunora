/**
 * The erasure tombstones, in a Durable Object of their own.
 *
 * A tombstone records that a subject was erased, so a restored backup can be erased
 * again. It must outlive the restore. `lunora backup pitr --restore` rolls the app's
 * shard back to a bookmark, and a tombstone stored in the shard would be rolled back
 * with the rows it exists to re-erase. This class has its own SQLite and its own
 * binding (`PRIVACY_TOMBSTONES`), and the restore never touches it.
 *
 * One named instance holds every tombstone. The keys are HMACs of subject ids, so
 * the table holds no raw identifier.
 */
import { DurableObject } from "cloudflare:workers";

export class PrivacyTombstonesDO extends DurableObject<Record<string, unknown>> {
    public constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
        super(ctx, env);
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tombstones (subject_key TEXT PRIMARY KEY, erased_at INTEGER NOT NULL)");
    }

    /** Record an erasure. Idempotent: a second erasure of the same subject moves the time forward. */
    public add(subjectKey: string, erasedAt: number): void {
        this.ctx.storage.sql.exec(
            "INSERT INTO tombstones (subject_key, erased_at) VALUES (?, ?) ON CONFLICT (subject_key) DO UPDATE SET erased_at = MAX(erased_at, excluded.erased_at)",
            subjectKey,
            erasedAt,
        );
    }

    /** Whether one subject's erasure is on record: a keyed lookup, so a check does not read every tombstone. */
    public has(subjectKey: string): boolean {
        return this.ctx.storage.sql.exec("SELECT 1 FROM tombstones WHERE subject_key = ? LIMIT 1", subjectKey).toArray().length > 0;
    }

    /** Every tombstone key on record. */
    public keys(): string[] {
        return this.ctx.storage.sql
            .exec<{ subject_key: string }>("SELECT subject_key FROM tombstones")
            .toArray()
            .map((row) => row.subject_key);
    }
}
