# backup

Scheduled, in-deployment snapshots for Lunora — **managed point-in-time recovery** (Convex-parity #19). A cron fires an internal action that exports a configured set of tables to a timestamped NDJSON object in a dedicated R2 bucket, and a second cron prunes snapshots past your retention window — so the whole loop is self-managing. It's the in-deployment counterpart to the `lunora backup` CLI: instead of an operator running an export by hand, your Worker snapshots (and ages out) backups on a cadence you choose.

Built from primitives Lunora already has — `ctx.db` reads plus [`@lunora/storage`](../../packages/storage)'s `createStorage` writing to (and listing/deleting from) R2 — so there's no new package and no Durable-Object-level support to enable.

The complete PITR loop is three pieces:

1. **`snapshot`** (internal action, cron-driven) — writes a timestamped full-table NDJSON snapshot to R2.
2. **`prune`** (internal action, cron-driven) — deletes snapshots older than your retention window so the bucket doesn't grow unbounded.
3. **`lunora backup restore`** (CLI) — imports the nearest snapshot, then optionally replays the CDC changelog forward to an arbitrary `--to <ISO>` time for fine-grained recovery.

## Install

```bash
lunora registry add backup
```

This:

1. Adds `@lunora/server` and `@lunora/storage` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/backup/index.ts` (the `snapshot` + `prune` internal actions) into your project — this is **yours** to edit.
3. Adds an `r2_buckets` entry to `wrangler.jsonc` binding **`BACKUP_BUCKET`** to a bucket named `lunora-backups` (see [Bindings](#bindings)).

Then create the bucket and regenerate types:

```bash
wrangler r2 bucket create lunora-backups
lunora codegen
```

Both actions surface in the generated `api` as `backup/snapshot` and `backup/prune` (i.e. `internal.backup.snapshot` / `internal.backup.prune`). They're **internal** actions, so they never appear on the public client API — only crons and other server functions can call them.

## How it works

- **snapshot** (internal action) reads every table listed in `TABLES` via `ctx.db.query(table).collect()` and writes a single timestamped object — `snapshots/lunora-backup-<iso>.ndjson` — to the `BACKUP_BUCKET` R2 bucket using `@lunora/storage`'s `createStorage(...).store(...)`.
- **prune** (internal action) lists everything under the `snapshots/` prefix via `createStorage(...).list("snapshots/", …)` (paginating R2's cursor until `truncated` is false) and `.delete(...)`s the objects outside your retention window. See [Retention](#retention) for the semantics.

The object is **NDJSON in the import format** — one `{"table":…,"doc":…}` object per row, the same line-delimited shape the `lunora backup` CLI and the admin export endpoint emit, and the only shape the admin `/apply` reader accepts (a line without its own `table` is rejected as `BAD_ROW`):

```ndjson
{"table":"messages","doc":{"_id":"…","body":"hi"}}
{"table":"users","doc":{"_id":"…","name":"Ada"}}
```

`snapshot` returns `{ key, bytes, rows, tables }` (per-table row counts) and `prune` returns `{ deleted, kept }` (the snapshot keys it removed and retained) so a wrapping job can log or alert on the result.

### You MUST list your tables

Lunora has no `ctx.db.listTables()` — an action context can't enumerate the schema — so the component can't "snapshot everything" generically. Edit the `TABLES` array in `lunora/backup/index.ts` to name every table you want backed up, and keep it in sync with `lunora/schema.ts`:

```ts
// lunora/backup/index.ts
const TABLES: readonly string[] = ["messages", "users", "channels"];
```

(You can also pass `{ tables: [...] }` for a one-off partial backup.) If `TABLES` is empty and no override is passed, `snapshot` throws — a deliberate guard so an unconfigured cron fails loudly instead of writing empty backups.

## Schedule the cron pair

Managed PITR is two scheduled jobs: one that **takes** snapshots and one that **ages them out**. This item ships **only** `lunora/backup/index.ts` — it does **not** ship a `lunora/crons.ts`, because crons live in a single project-owned file and an item that created its own would collide with any other cron-shipping item (and with your existing crons). Register both yourself in `lunora/crons.ts` (create it if you don't have one):

```ts
// lunora/crons.ts
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Take a snapshot daily at 03:00 UTC.
crons.daily("backup snapshot", { hourUTC: 3, minuteUTC: 0 }, internal.backup.snapshot, {});

// Prune snapshots daily at 04:00 UTC — keep 30 days, but never fewer than the 5
// most recent (see Retention). Run it after the snapshot so the fresh one counts.
crons.daily("backup prune", { hourUTC: 4, minuteUTC: 0 }, internal.backup.prune, { keepDays: 30, keepLast: 5 });

export default crons;
```

`@lunora/codegen` discovers `cronJobs()` registrations statically (by AST), so the schedules and dispatcher are emitted into wrangler + `_generated` on `lunora codegen` — you never edit `triggers.crons` by hand. Other schedule kinds are available: `crons.interval("…", { hours: 6 }, …)`, `crons.weekly`, `crons.monthly`, and the raw `crons.cron("…", "0 3 * * *", …)` escape hatch.

> Cron names must be unique across the project. If you already register crons, just add the two `crons.daily(...)` lines to your existing builder rather than creating a second `cronJobs()`.

## Retention

`prune` deletes snapshots that fall outside your retention window. Pass `keepDays`, `keepLast`, or both:

- **`keepDays`** — keep snapshots written within the last N days; older ones are eligible for deletion.
- **`keepLast`** — keep the N most-recent snapshots (by upload time), regardless of age.

When you pass **both**, they combine as a logical OR over _protection_: a snapshot is deleted only if it's **both** older than `keepDays` **and** not among the `keepLast` newest. So `{ keepDays: 30, keepLast: 5 }` keeps everything from the last 30 days **and** always retains your 5 latest snapshots even if all of them are older than 30 days — you can never prune your way down to zero restore points.

Calling `prune` with **neither** argument throws — a deliberate guard so a misconfigured cron fails loudly rather than silently deleting (or keeping) everything. It returns `{ deleted, kept }` listing the affected keys.

## Bindings

`lunora registry add backup` writes this into `wrangler.jsonc`:

```jsonc
{
    "r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "lunora-backups" }],
}
```

`lunora registry add` **merges** this into any existing `r2_buckets` array (it won't drop buckets you already have), and is idempotent on re-run. Rename `bucket_name` to the R2 bucket you actually created.

Both `snapshot` and `prune` in `lunora/backup/index.ts` read the bucket via `import { env } from "cloudflare:workers"` and hand `env.BACKUP_BUCKET` (cast to `R2BucketLike` and guarded) to `createStorage({ bucket, bucketName })`. The `cloudflare:workers` types come from your project's `@cloudflare/workers-types` + generated `Env`.

## Restore

Snapshots are plain NDJSON in the import format, so recovery is a straight import — download the object you want from the bucket and feed it to the restore CLI:

```bash
lunora backup restore ./lunora-backup-2026-06-07T03-00-00-000Z.ndjson
```

Two things this tier does **not** give you, both of which `lunora backup create` does: these snapshots go to the `snapshots/` prefix rather than the `backups/` history `lunora backup list` reads, and they are written without a `.manifest.json` sidecar — so they do not appear in `list`, and `restore --verify` has no recorded checksum to check them against. Point `restore` at the file (or the object key) directly and leave `--verify` off.

For **in-place time-travel to an arbitrary moment** (rather than to a snapshot boundary), use **native PITR** — `lunora backup pitr` / the studio — which restores the shard from the platform's own change log to any point in the last 30 days (see below). This off-platform snapshot path is for portable, cross-deployment, or >30-day recovery; `prune`'s retention window is your recovery floor here. See [`lunora backup`](../../packages/cli/src/commands/backup/handler.ts) (`create | list | restore | prune | retention | pitr`) and Cloudflare D1 Time Travel for the `.global()` plane.

## Two recovery tiers

This item is the **off-platform / long-horizon** tier — portable NDJSON in _your_ R2 bucket, restorable across deployments and beyond 30 days, with retention you control. For quick **in-place** recovery, prefer Lunora's **native PITR**: SQLite-backed shards can restore their whole database to any bookmark in the **last 30 days** via the platform's change log, exposed as the admin ops `getPitrBookmark` (current / for-a-time bookmark) and `pitrRestore` (`{ time | bookmark, restart? }`, returns an **undo bookmark**, audited). Native PITR is one round-trip with no R2 read; this item is what you reach for when the moment is older than 30 days, or you need a portable copy off the platform.

## What you own

Everything under `lunora/backup/` is copied into your repo — change the table list, the object key scheme, the framing format, the retention semantics, switch to per-table objects, or compress the body however you like. `@lunora/storage` provides the R2 wrapper; this component is the idiomatic Lunora glue that turns it into a scheduled snapshot + prune pair.
