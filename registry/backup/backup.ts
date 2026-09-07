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
 *     **Shard-local** — see {@link snapshot}'s "What this snapshot covers".
 *   - **prune** (internalAction) — lists the snapshot objects in `BACKUP_BUCKET`
 *     and deletes those that fall outside your retention window, so the scheduled
 *     snapshot loop is self-managing. Also *internal*; schedule it alongside
 *     `snapshot` as the second half of the PITR cron pair.
 *
 * Together with the `lunora backup restore` CLI these two actions close the
 * off-platform recovery loop:
 *   - **Table list is explicit.** Lunora has no `ctx.db.listTables()`, so a
 *     generic "snapshot everything" isn't reachable from an action context. You
 *     MUST keep {@link TABLES} in sync with your `lunora/schema.ts` — see the
 *     TODO below.
 *   - **Restore is out-of-band.** Pull an object back and feed it to
 *     `lunora backup restore <id|file>` — the CLI imports NDJSON through the
 *     admin `/apply` endpoint. It restores to the snapshot boundary, not to an
 *     arbitrary moment: there is no `--to` and no CDC replay on this path. For
 *     in-place time-travel to any point in the last 30 days use native PITR
 *     (`lunora backup pitr --at <ISO>`), which reads the platform's own change
 *     log rather than a snapshot.
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
 * The transport's tagged-value sentinel. Every wire-encoded leaf below is an
 * array whose first element is this string; `lunora backup restore` runs the
 * admin `/apply` reader, which decodes exactly this form back to real values.
 */
const WIRE_TAG = "$lunora.wire$";

/** Nesting limit, matching the transport codec — a runaway structure fails here, not on the stack. */
const MAX_WIRE_DEPTH = 64;

/**
 * Base64 in fixed-size chunks so a large `v.bytes()` column never overflows
 * `String.fromCharCode`'s argument ceiling via a single spread.
 */
const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x80_00;

    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }

    return btoa(binary);
};

/**
 * Encode one document value into the JSON-safe tagged form the transport uses.
 *
 * **This is why `JSON.stringify` alone is not enough.** `ctx.db` hands back
 * DECODED values: a `v.bigint()` column is a real `bigint` and a `v.bytes()`
 * column a real `ArrayBuffer`. `JSON.stringify(1n)` **throws**
 * (`TypeError: Do not know how to serialize a BigInt`), so a single bigint
 * column means the cron fails and no snapshot is ever written; an `ArrayBuffer`
 * silently flattens to `{}`, which is worse — `rows`/`bytes` look healthy and
 * the loss is only discovered at recovery. `Date`, `Map`, `Set`, `URL` and
 * `Error` have no own enumerable keys and flatten the same way.
 *
 * The platform's own export path wraps every admin result in the same codec for
 * exactly this reason, which is what makes a snapshot written here and one
 * written by `lunora backup create` interchangeable — both are decoded by
 * `/apply` on the way back in. The codec is the identity on pure-JSON values,
 * so a document with no special leaves produces byte-identical JSON to a bare
 * `JSON.stringify`.
 *
 * A non-plain object with no supported case (a `RegExp`, a class instance)
 * throws rather than encoding to `{}`: a loud failure beats a snapshot that
 * restores empty columns.
 */
const encodeWire = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_WIRE_DEPTH) {
        throw new RangeError(`backup/snapshot: document nesting exceeds the ${String(MAX_WIRE_DEPTH)}-level limit`);
    }

    if (value === undefined) {
        // Only reachable in an array position — object fields are dropped below,
        // as `JSON.stringify` does. Tagged so the slot is not coerced to `null`.
        return [WIRE_TAG, "undefined"];
    }

    if (value === null) {
        return null;
    }

    if (typeof value === "bigint") {
        return [WIRE_TAG, "bigint", value.toString()];
    }

    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return [WIRE_TAG, "nan"];
        }

        if (value === Infinity) {
            return [WIRE_TAG, "inf"];
        }

        if (value === -Infinity) {
            return [WIRE_TAG, "-inf"];
        }

        return value;
    }

    if (typeof value !== "object") {
        // string, boolean — JSON-safe as-is.
        return value;
    }

    if (value instanceof Date) {
        // Epoch-ms, routed back through this function so an Invalid Date's `NaN`
        // survives as a tag instead of becoming `null` (i.e. epoch 0).
        return [WIRE_TAG, "date", encodeWire(value.getTime(), depth + 1)];
    }

    if (value instanceof Error) {
        const error = value as Error & Record<string, unknown>;
        const properties: Record<string, unknown> = {};

        for (const key of Object.keys(error)) {
            if (error[key] !== undefined) {
                properties[key] = encodeWire(error[key], depth + 1);
            }
        }

        // `stack` is deliberately omitted; `cause` is a non-enumerable own prop,
        // so it rides in a positional slot rather than in `properties`.
        const encodedError: unknown[] = [WIRE_TAG, "error", error.name, error.message, properties];

        if (error.cause !== undefined) {
            encodedError.push(encodeWire(error.cause, depth + 1));
        }

        return encodedError;
    }

    if (value instanceof URL) {
        return [WIRE_TAG, "url", value.href];
    }

    if (value instanceof Map) {
        return [WIRE_TAG, "map", [...value.entries()].map(([key, item]) => [encodeWire(key, depth + 1), encodeWire(item, depth + 1)])];
    }

    if (value instanceof Set) {
        return [WIRE_TAG, "set", [...value].map((item) => encodeWire(item, depth + 1))];
    }

    if (value instanceof ArrayBuffer) {
        return [WIRE_TAG, "bytes", toBase64(new Uint8Array(value)), "ArrayBuffer"];
    }

    if (ArrayBuffer.isView(value)) {
        const name = value.constructor.name;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

        // `Uint8Array` keeps the 2-element form; every other view carries its
        // constructor name so the decoder rebuilds the exact view type.
        return name === "Uint8Array" ? [WIRE_TAG, "bytes", toBase64(bytes)] : [WIRE_TAG, "bytes", toBase64(bytes), name];
    }

    if (Array.isArray(value)) {
        const encoded = value.map((item) => encodeWire(item, depth + 1));

        // Escape a real array that would otherwise be mistaken for a tagged value
        // because its first element is literally the sentinel string.
        return encoded.length > 0 && encoded[0] === WIRE_TAG ? [WIRE_TAG, "arr", encoded] : encoded;
    }

    const proto: unknown = Object.getPrototypeOf(value);

    if (proto !== null && proto !== Object.prototype) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "value";

        throw new TypeError(
            `backup/snapshot: cannot serialise a ${name} — only plain objects, arrays and the supported built-ins (Date, Error, URL, Map, Set, ArrayBuffer/typed arrays, bigint) survive a snapshot/restore round-trip`,
        );
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        const field = source[key];

        if (field === undefined) {
            continue;
        }

        const encoded = encodeWire(field, depth + 1);

        if (key === "__proto__") {
            // A plain assignment fires the prototype SETTER instead of creating an
            // own property, silently dropping a literal `__proto__` field.
            Object.defineProperty(result, key, { configurable: true, enumerable: true, value: encoded, writable: true });
        } else {
            result[key] = encoded;
        }
    }

    return result;
};

/**
 * Serialise a table's rows as NDJSON in the import format: one
 * `{"table":"<name>","doc":{…}}` object per line, each document run through
 * {@link encodeWire} first.
 *
 * The `table` is on **every** line rather than in a header line above the block.
 * That is not a style choice: `lunora backup restore` streams the file through
 * the admin `/apply` endpoint, whose reader rejects any line without its own
 * `table` and `doc` (`BAD_ROW: row is missing \`table\``). A header-framed body
 * therefore restored ZERO rows, and the operator found out at recovery time.
 */
const toNdjson = (table: string, rows: ReadonlyArray<Record<string, unknown>>): string =>
    rows.map((doc) => JSON.stringify({ doc: encodeWire(doc), table })).join("\n");

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
 *
 * # What this snapshot covers
 *
 * `ctx.db` is **shard-local**. A `.global()` table is read from the replicated
 * plane and is therefore complete, but a shard-local table yields only the rows
 * of the shard this action is running on — and a cron dispatches to the default
 * shard. On a `.shardBy(...)` deployment that means every other shard's rows are
 * missing from the object, while `rows`/`tables` still report plausible counts,
 * so nothing about the run looks wrong until a restore brings back one tenant
 * out of hundreds.
 *
 * Fanning out is not reachable from here: shard discovery lives behind the
 * query coordinator, and neither `ctx.db` nor `ctx.scheduler` takes a shard key.
 * So the run says so out loud instead ({@link snapshot} logs a warning every
 * time), and a sharded deployment should take its whole-deployment snapshots
 * with `lunora backup create --bucket` or the platform's `backupCron`, both of
 * which fan out over every shard. Delete the warning if you have confirmed your
 * schema declares no `.shardBy()` table — this item is yours.
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

        // Said out loud, once per run, to the operator whose backup is short:
        // `ctx.db` only sees this shard, and the returned counts cannot tell a
        // partial snapshot from a deployment that genuinely has one shard. The
        // platform's own exporter prints the same warning when it cannot fan
        // out. Delete this if your schema declares no `.shardBy()` table.
        ctx.log.warn("backup/snapshot: reads through a shard-local `ctx.db`, so a `.shardBy()` deployment's other shards are NOT in this object", {
            remedy: "take whole-deployment snapshots with `lunora backup create --bucket`, or the platform's `backupCron`",
            tables: targets,
        });

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
