# backup

Scheduled, in-deployment snapshots for Cirrus — the **automatic point-in-time-recovery building block** (Convex-parity #19). A cron fires an internal action on a schedule, which exports a configured set of tables to a timestamped NDJSON object in a dedicated R2 bucket. It's the in-deployment counterpart to the `cirrus backup` CLI: instead of an operator running an export by hand, your Worker snapshots itself on a cadence you choose.

Built from primitives Cirrus already has — `ctx.db` reads plus [`@cirrus/storage`](../../packages/storage)'s `createStorage` writing to R2 — so there's no new package and no Durable-Object-level support to enable.

## Install

```bash
cirrus registry add backup
```

This:

1. Adds `@cirrus/server` and `@cirrus/storage` to your `package.json` (run `pnpm install` afterwards).
2. Copies `cirrus/backup/index.ts` (the `snapshot` internal action) into your project — this is **yours** to edit.
3. Adds an `r2_buckets` entry to `wrangler.jsonc` binding **`BACKUP_BUCKET`** to a bucket named `cirrus-backups` (see [Bindings](#bindings)).

Then create the bucket and regenerate types:

```bash
wrangler r2 bucket create cirrus-backups
cirrus codegen
```

The action surfaces in the generated `api` as `backup/snapshot` (i.e. `internal.backup.snapshot`). It's an **internal** action, so it never appears on the public client API — only crons and other server functions can call it.

## How it works

- **snapshot** (internal action) reads every table listed in `TABLES` via `ctx.db.query(table).collect()` and writes a single timestamped object — `snapshots/cirrus-backup-<iso>.ndjson` — to the `BACKUP_BUCKET` R2 bucket using `@cirrus/storage`'s `createStorage(...).store(...)`.

The object is **NDJSON framed by per-table header lines**, the same line-delimited format the `cirrus backup` CLI and the admin export endpoint emit:

```ndjson
{"__table":"messages"}
{"_id":"…","body":"hi"}
{"__table":"users"}
{"_id":"…","name":"Ada"}
```

It returns `{ key, bytes, rows, tables }` (per-table row counts) so a wrapping job can log or alert on the result.

### You MUST list your tables

Cirrus has no `ctx.db.listTables()` — an action context can't enumerate the schema — so the component can't "snapshot everything" generically. Edit the `TABLES` array in `cirrus/backup/index.ts` to name every table you want backed up, and keep it in sync with `cirrus/schema.ts`:

```ts
// cirrus/backup/index.ts
const TABLES: readonly string[] = ["messages", "users", "channels"];
```

(You can also pass `{ tables: [...] }` for a one-off partial backup.) If `TABLES` is empty and no override is passed, `snapshot` throws — a deliberate guard so an unconfigured cron fails loudly instead of writing empty backups.

## Schedule it

This item ships **only** `cirrus/backup/index.ts` — it does **not** ship a `cirrus/crons.ts`, because crons live in a single project-owned file and an item that created its own would collide with any other cron-shipping item (and with your existing crons). Register the snapshot yourself in `cirrus/crons.ts` (create it if you don't have one):

```ts
// cirrus/crons.ts
import { cronJobs } from "@cirrus/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Daily at 03:00 UTC.
crons.daily("backup snapshot", { hourUTC: 3, minuteUTC: 0 }, internal.backup.snapshot, {});

export default crons;
```

`@cirrus/codegen` discovers `cronJobs()` registrations statically (by AST), so the schedule and dispatcher are emitted into wrangler + `_generated` on `cirrus codegen` — you never edit `triggers.crons` by hand. Other schedule kinds are available: `crons.interval("…", { hours: 6 }, …)`, `crons.weekly`, `crons.monthly`, and the raw `crons.cron("…", "0 3 * * *", …)` escape hatch.

> Cron names must be unique across the project. If you already register crons, just add the `crons.daily("backup snapshot", …)` line to your existing builder rather than creating a second `cronJobs()`.

## Bindings

`cirrus registry add backup` writes this into `wrangler.jsonc`:

```jsonc
{
    "r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "cirrus-backups" }],
}
```

`cirrus registry add` **merges** this into any existing `r2_buckets` array (it won't drop buckets you already have), and is idempotent on re-run. Rename `bucket_name` to the R2 bucket you actually created.

`cirrus/backup/index.ts` reads the bucket via `import { env } from "cloudflare:workers"` and hands `env.BACKUP_BUCKET` (cast to `R2BucketLike` and guarded) to `createStorage({ bucket })`. The `cloudflare:workers` types come from your project's `@cloudflare/workers-types` + generated `Env`.

## Retention is yours to add

Nothing prunes old snapshots — the bucket grows unbounded by design, so you keep full control of your retention/PITR window. Add a second cron that lists and deletes objects past your window (a `prune` `internalAction` that `storage.list("snapshots/")`s, filters by `uploaded` age, and `storage.delete(...)`s the stale keys), then schedule it with e.g. `crons.daily("backup prune", { hourUTC: 4, minuteUTC: 0 }, internal.backup.prune, { keepDays: 30 })`.

## Restore

Snapshots are plain NDJSON, so recovery goes through the existing CLI restore path. Download the object you want from the bucket and feed it to:

```bash
# Restore a specific snapshot file (NDJSON imported via the admin /apply endpoint).
cirrus backup restore ./cirrus-backup-2026-06-07T03-00-00-000Z.ndjson

# Or, for finer recovery, pair a base snapshot with CDC replay up to a moment:
cirrus backup restore <id> --to 2026-06-07T12:00:00Z
```

See [`cirrus backup`](../../packages/cli/src/commands/backup.ts) (`create | list | restore`) for the full restore surface, including point-in-time `--to` replay over the changelog and pairing with Cloudflare D1 Time Travel.

## What you own

Everything under `cirrus/backup/` is copied into your repo — change the table list, the object key scheme, the framing format, add a `prune` job, switch to per-table objects, or compress the body however you like. `@cirrus/storage` provides the R2 wrapper; this component is the idiomatic Cirrus glue that turns it into a scheduled snapshot.
