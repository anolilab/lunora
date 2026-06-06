/**
 * Backup functions — added by `cirrus registry add backup`.
 *
 * This file is YOURS: it's a normal Cirrus module, copied into your project so
 * you own and edit it. It is the in-deployment, scheduled counterpart to the
 * `cirrus backup` CLI — instead of an operator running an export, a cron fires
 * the {@link snapshot} internalAction on a schedule and streams a point-in-time
 * snapshot of your data into a dedicated R2 bucket.
 *
 * Surface (after you re-export it / rely on file discovery, it emits as
 * `backup/snapshot`):
 *
 *   - **snapshot** (internalAction) — reads the rows of every table in
 *     {@link TABLES} via `ctx.db` and writes one timestamped NDJSON object to the
 *     `BACKUP_BUCKET` R2 bucket. *Internal* (server-only) so a client can never
 *     trigger a full-table dump; drive it from a cron (see the README).
 *
 * This is a point-in-time-recovery *building block*, not a turnkey PITR system:
 *   - **Table list is explicit.** Cirrus has no `ctx.db.listTables()`, so a
 *     generic "snapshot everything" isn't reachable from an action context. You
 *     MUST keep {@link TABLES} in sync with your `cirrus/schema.ts` — see the
 *     TODO below.
 *   - **Retention is yours to add.** Nothing prunes old snapshots; wire a second
 *     cron that lists + deletes objects past your retention window.
 *   - **Restore is out-of-band.** Pull an object back and feed it to
 *     `cirrus backup restore <id|file>` (the CLI imports NDJSON through the admin
 *     `/apply` endpoint).
 */
import { internalAction, v } from "@cirrus/server";
import { createStorage } from "@cirrus/storage";
import type { R2BucketLike } from "@cirrus/storage";
// `env` from `cloudflare:workers` exposes the worker's configured bindings (here
// the BACKUP_BUCKET R2 bucket) — the standard Workers way to reach a binding
// outside the top-level `fetch`/`scheduled` handler. Ambient types come from
// your project's `@cloudflare/workers-types` + generated `Env`.
import { env } from "cloudflare:workers";

// TODO: list every table you want backed up. Cirrus can't enumerate tables from
// an action context, so this list is the source of truth for what `snapshot`
// dumps. Keep it in sync with the tables you `defineTable(...)` in
// `cirrus/schema.ts` (a future codegen pass could emit this for you).
const TABLES: readonly string[] = [
    // "messages",
    // "users",
];

/** Key prefix every snapshot object is written under, inside the bucket. */
const BACKUP_PREFIX = "snapshots";

/**
 * Serialise an array of rows as NDJSON (one JSON document per line). NDJSON is
 * the same line-delimited format `cirrus backup` / the admin export endpoint
 * emit, so a snapshot written here is consumable by `cirrus backup restore`.
 */
const toNdjson = (rows: ReadonlyArray<Record<string, unknown>>): string => rows.map((row) => JSON.stringify(row)).join("\n");

/**
 * Snapshot the configured {@link TABLES} into one timestamped object in
 * `BACKUP_BUCKET`. Returns the written key plus per-table and total row counts.
 *
 * The object body is a single NDJSON stream framed by per-table header lines
 * (`{"__table":"<name>"}`) so a restorer can split rows back into their tables:
 *
 * ```ndjson
 * {"__table":"messages"}
 * {"_id":"…","body":"hi"}
 * {"__table":"users"}
 * {"_id":"…","name":"Ada"}
 * ```
 */
export const snapshot = internalAction({
    args: {
        /** Optional override of the configured table list (e.g. a partial backup). */
        tables: v.optional(v.array(v.string())),
    },
    handler: async (ctx, { tables }): Promise<{ bytes: number; key: string; rows: number; tables: Record<string, number> }> => {
        const targets = tables ?? TABLES;

        if (targets.length === 0) {
            throw new Error("backup/snapshot: no tables configured — edit the TABLES list in cirrus/backup/index.ts (or pass { tables }) before scheduling.");
        }

        // `env` values are typed `unknown` (see the registry's cloudflare-workers
        // shim); narrow the R2 binding explicitly, then guard it.
        const bucket = env.BACKUP_BUCKET as R2BucketLike | undefined;

        if (!bucket) {
            throw new Error(`backup/snapshot: missing R2 binding "BACKUP_BUCKET" — add it to wrangler.jsonc r2_buckets (see the backup README).`);
        }

        const storage = createStorage({ bucket });

        const perTable: Record<string, number> = {};
        const chunks: string[] = [];
        let total = 0;

        // Sequential per-table reads: each `collect()` is its own snapshot read,
        // and streaming them in order keeps memory bounded by the largest table
        // rather than the whole database materialised at once.
        for (const table of targets) {
            // eslint-disable-next-line no-await-in-loop -- ordered, bounded per-table reads (see above)
            const rows = await ctx.db.query(table).collect();

            chunks.push(JSON.stringify({ __table: table }), toNdjson(rows));
            perTable[table] = rows.length;
            total += rows.length;
        }

        const body = `${chunks.filter((chunk) => chunk.length > 0).join("\n")}\n`;
        // Colons/periods are awkward in object keys across tooling; flatten them,
        // mirroring how the `cirrus backup` CLI names its files.
        const stamp = new Date().toISOString().replaceAll(/[.:]/gu, "-");
        const key = `${BACKUP_PREFIX}/cirrus-backup-${stamp}.ndjson`;

        await storage.store(key, new TextEncoder().encode(body).buffer as ArrayBuffer, {
            contentType: "application/x-ndjson",
        });

        return { bytes: body.length, key, rows: total, tables: perTable };
    },
});
