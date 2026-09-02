/**
 * Backup functions — added by `lunora registry add backup`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. It is the in-deployment, scheduled counterpart to the
 * `lunora backup` CLI — instead of an operator running an export, a cron fires
 * the {@link snapshot} internalAction on a schedule and streams a point-in-time
 * snapshot of your data into a dedicated R2 bucket.
 *
 * Surface (after you re-export it / rely on file discovery, these emit as
 * `backup/snapshot` and `backup/prune`):
 *
 *   - **snapshot** (internalAction) — reads the rows of every table in
 *     {@link TABLES} via `ctx.db` and writes one timestamped NDJSON object to the
 *     `BACKUP_BUCKET` R2 bucket. *Internal* (server-only) so a client can never
 *     trigger a full-table dump; drive it from a cron (see the README).
 *   - **prune** (internalAction) — lists the snapshot objects in `BACKUP_BUCKET`
 *     and deletes those that fall outside your retention window, so the scheduled
 *     snapshot loop is self-managing. Also *internal*; schedule it alongside
 *     `snapshot` as the second half of the PITR cron pair.
 *
 * Together with the `lunora backup restore` CLI (which imports the nearest
 * snapshot and can roll the CDC changelog forward to an arbitrary `--to` time),
 * these two actions close the managed point-in-time-recovery loop:
 *   - **Table list is explicit.** Lunora has no `ctx.db.listTables()`, so a
 *     generic "snapshot everything" isn't reachable from an action context. You
 *     MUST keep {@link TABLES} in sync with your `lunora/schema.ts` — see the
 *     TODO below.
 *   - **Restore is out-of-band.** Pull an object back and feed it to
 *     `lunora backup restore <id|file>` (the CLI imports NDJSON through the admin
 *     `/apply` endpoint), optionally with `--to <ISO>` for CDC replay.
 */
import { internalAction, v } from "#lunora/_generated/server.js";
import { createStorage } from "@lunora/storage";
import type { R2BucketLike } from "@lunora/storage";
// `env` from `cloudflare:workers` exposes the worker's configured bindings (here
// the BACKUP_BUCKET R2 bucket) — the standard Workers way to reach a binding
// outside the top-level `fetch`/`scheduled` handler. Ambient types come from
// your project's `@cloudflare/workers-types` + generated `Env`.
import { env } from "cloudflare:workers";

// TODO: list every table you want backed up. Lunora can't enumerate tables from
// an action context, so this list is the source of truth for what `snapshot`
// dumps. Keep it in sync with the tables you `defineTable(...)` in
// `lunora/schema.ts` (a future codegen pass could emit this for you).
const TABLES: readonly string[] = [
    // "messages",
    // "users",
];

/** Key prefix every snapshot object is written under, inside the bucket. */
const BACKUP_PREFIX = "snapshots";

/**
 * Serialise a table's rows as NDJSON in the import format: one
 * `{"table":"<name>","doc":{…}}` object per line.
 *
 * The `table` is on **every** line rather than in a header line above the block.
 * That is not a style choice: `lunora backup restore` streams the file through
 * the admin `/apply` endpoint, whose reader rejects any line without its own
 * `table` and `doc` (`BAD_ROW: row is missing \`table\``). A header-framed body
 * therefore restored ZERO rows, and the operator found out at recovery time.
 */
const toNdjson = (table: string, rows: ReadonlyArray<Record<string, unknown>>): string => rows.map((doc) => JSON.stringify({ doc, table })).join("\n");

/**
 * Snapshot the configured {@link TABLES} into one timestamped object in
 * `BACKUP_BUCKET`. Returns the written key plus per-table and total row counts.
 *
 * The object body is a single NDJSON stream in the import format — one
 * `{"table":…,"doc":…}` per row, which is exactly what `lunora backup restore`
 * feeds to the admin `/apply` endpoint:
 *
 * ```ndjson
 * {"table":"messages","doc":{"_id":"…","body":"hi"}}
 * {"table":"users","doc":{"_id":"…","name":"Ada"}}
 * ```
 */
export const snapshot = internalAction
    .input({
        /** Optional override of the configured table list (e.g. a partial backup). */
        tables: v.optional(v.array(v.string())),
    })
    .action(async ({ args: { tables }, ctx }): Promise<{ bytes: number; key: string; rows: number; tables: Record<string, number> }> => {
        const targets = tables ?? TABLES;

        if (targets.length === 0) {
            throw new Error("backup/snapshot: no tables configured — edit the TABLES list in lunora/backup/index.ts (or pass { tables }) before scheduling.");
        }

        // `env` values are typed `unknown` (see the registry's cloudflare-workers
        // shim); narrow the R2 binding explicitly, then guard it.
        const bucket = env.BACKUP_BUCKET as R2BucketLike | undefined;

        if (!bucket) {
            throw new Error(`backup/snapshot: missing R2 binding "BACKUP_BUCKET" — add it to wrangler.jsonc r2_buckets (see the backup README).`);
        }

        const storage = createStorage({ bucket, bucketName: "default" });

        const perTable: Record<string, number> = {};
        const chunks: string[] = [];
        let total = 0;

        // Sequential per-table reads: each `collect()` is its own snapshot read,
        // and streaming them in order keeps memory bounded by the largest table
        // rather than the whole database materialised at once.
        for (const table of targets) {
            // eslint-disable-next-line no-await-in-loop -- ordered, bounded per-table reads (see above)
            const rows = await ctx.db.query(table).collect();

            chunks.push(toNdjson(table, rows));
            perTable[table] = rows.length;
            total += rows.length;
        }

        const body = `${chunks.filter((chunk) => chunk.length > 0).join("\n")}\n`;
        // Encode once so the reported `bytes` matches the bytes actually stored:
        // `body.length` is UTF-16 code units, but the object written to R2 is the
        // UTF-8 encoding, which differs for any non-ASCII content.
        const encoded = new TextEncoder().encode(body);
        // Colons/periods are awkward in object keys across tooling; flatten them,
        // mirroring how the `lunora backup` CLI names its files.
        const stamp = new Date().toISOString().replaceAll(/[.:]/gu, "-");
        const key = `${BACKUP_PREFIX}/lunora-backup-${stamp}.ndjson`;

        await storage.store(key, encoded.buffer as ArrayBuffer, {
            contentType: "application/x-ndjson",
        });

        return { bytes: encoded.byteLength, key, rows: total, tables: perTable };
    });

/** Milliseconds in a day — the unit `keepDays` is measured in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prune old snapshots from `BACKUP_BUCKET` so the scheduled {@link snapshot}
 * loop is self-managing — the missing "managed" half of point-in-time recovery.
 * Lists every object under {@link BACKUP_PREFIX} and deletes the ones outside
 * your retention window. Returns the deleted/kept keys so a wrapping cron can log
 * or alert on what it removed.
 *
 * **Retention semantics** — pass `keepDays`, `keepLast`, or both:
 *
 *   - `keepDays` — protect snapshots written within the last N days (anything
 *     newer than `now - keepDays` is kept; older ones are eligible for deletion).
 *   - `keepLast` — protect the N most-recent snapshots (by upload time),
 *     regardless of age.
 *
 * When **both** are given they are combined as a logical OR over *protection*: a
 * snapshot is deleted only if it satisfies neither rule — i.e. it is **both**
 * older than `keepDays` **and** not among the `keepLast` newest. This is the safe
 * reading ("keep it if any rule says to"), so e.g. `{ keepDays: 30, keepLast: 5 }`
 * always retains your 5 latest snapshots even if all of them are older than 30
 * days, guaranteeing you never prune your way down to zero restore points.
 *
 * At least one of `keepDays` / `keepLast` must be supplied — calling `prune` with
 * neither throws, a deliberate guard so a misconfigured cron fails loudly instead
 * of silently deleting (or silently keeping) everything.
 *
 * Objects R2 reports without an `uploaded` timestamp are treated as un-ageable and
 * are kept by the `keepDays` rule; the object key itself encodes the snapshot's
 * ISO stamp, so age ordering also stays stable for the `keepLast` rule via the
 * key sort below.
 */
export const prune = internalAction
    .input({
        /** Keep only the N most-recent snapshots; older surplus is eligible for deletion. */
        keepLast: v.optional(v.number()),
        /** Keep snapshots written within the last N days; older ones are eligible for deletion. */
        keepDays: v.optional(v.number()),
    })
    .action(async ({ args: { keepDays, keepLast } }): Promise<{ deleted: string[]; kept: string[] }> => {
        if (keepDays === undefined && keepLast === undefined) {
            throw new Error("backup/prune: pass keepDays and/or keepLast — refusing to prune with no retention window configured.");
        }

        // Same binding narrowing the `snapshot` action uses: `env` values are
        // typed `unknown` (registry cloudflare-workers shim), so cast the R2
        // binding explicitly, then guard it.
        const bucket = env.BACKUP_BUCKET as R2BucketLike | undefined;

        if (!bucket) {
            throw new Error(`backup/prune: missing R2 binding "BACKUP_BUCKET" — add it to wrangler.jsonc r2_buckets (see the backup README).`);
        }

        const storage = createStorage({ bucket, bucketName: "default" });

        // Page through every snapshot object. `list` caps a single page at 1000
        // (R2's limit), so follow the cursor until R2 stops reporting `truncated`.
        const objects: { key: string; uploaded?: Date }[] = [];
        let cursor: string | undefined;

        do {
            // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
            const page = await storage.list(`${BACKUP_PREFIX}/`, { cursor, limit: 1000 });

            for (const object of page.objects) {
                objects.push({ key: object.key, uploaded: object.uploaded });
            }

            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);

        // Newest first. The snapshot key embeds an ISO stamp, so a key sort is a
        // stable fallback when R2 omits `uploaded`; when present, `uploaded` (a
        // `Date`) is the authoritative order.
        objects.sort((a, b) => {
            const at = a.uploaded?.getTime();
            const bt = b.uploaded?.getTime();

            if (at !== undefined && bt !== undefined && at !== bt) {
                return bt - at;
            }

            return a.key < b.key ? 1 : -1;
        });

        const cutoff = keepDays === undefined ? undefined : Date.now() - keepDays * MS_PER_DAY;

        const deleted: string[] = [];
        const kept: string[] = [];

        // `index` is the newest-first rank, so `index < keepLast` protects the N
        // most-recent objects.
        for (const [index, object] of objects.entries()) {
            const withinAge =
                cutoff === undefined
                    ? // No keepDays rule → age never protects (only keepLast can).
                      false
                    : // Missing `uploaded` is treated as un-ageable → protected.
                      object.uploaded === undefined || object.uploaded.getTime() >= cutoff;

            const withinCount = keepLast !== undefined && index < keepLast;

            if (withinAge || withinCount) {
                kept.push(object.key);
            } else {
                deleted.push(object.key);
            }
        }

        // Delete sequentially to keep the request/subrequest fan-out bounded — a
        // prune over a large bucket otherwise issues hundreds of parallel R2
        // calls and can trip the Worker subrequest ceiling.
        for (const key of deleted) {
            // eslint-disable-next-line no-await-in-loop -- bounded sequential deletes (see above)
            await storage.delete(key);
        }

        return { deleted, kept };
    });
