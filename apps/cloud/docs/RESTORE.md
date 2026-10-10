# Restore runbook

Two kinds of data, backed up separately:

- **The control-plane D1** — [first half](#control-plane-d1) of this page.
- **Tenant data** — each project's Durable Object storage and `.global()` D1
  tables — [second half](#tenant-data).

## Control-plane D1

The control-plane D1 is the one store in the platform whose loss is
unrecoverable rather than inconvenient. What is only in this database is
**which cell a tenant is on, which script serves it, and the sealed admin token
that reaches it**. Without it the tenant workers keep serving traffic and
nothing can be administered, billed, deployed, or torn down. It is also where
the tenant backup records live, so losing it loses the index of tenant
snapshots — the objects themselves survive in `TENANT_BACKUPS` and can still be
restored by hand (below).

### What protects it

Two layers, and they fail differently.

| Layer                                  | Recovers from                                 | Does not recover from                    |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| **D1 Time Travel** (automatic)         | A bad write, a dropped table, a bad migration | Losing the database or the account       |
| **This backup sweep**                  | Losing the database                           | Losing the **account**                   |
| **The off-site copy** (when it is set) | Losing the account                            | Losing both accounts; see the note below |

Time Travel is Cloudflare's, needs no code, and covers 30 days. Reach for it
first: it is faster, exact to the second, and does not involve a dump at all.
The sweep exists because Time Travel history lives inside the database it
protects, so a deleted or compromised account takes the history with it.

> **Off-account only when configured.** The primary dump is written to R2 **in
> the same account** (a Worker's R2 binding cannot address another one). Only a
> cell with the [off-site copy](#off-site-copy) configured survives an
> account-level loss; on any other cell, do not describe this as off-account DR.

### What the sweep does

`src/backup/sweep.ts`, on the existing six-hourly cron trigger (a fourth trigger
is not available — Cloudflare caps a Worker at three).

1. `POST /d1/database/<id>/export` and poll to completion.
2. `GET` the presigned URL it answers — valid for one hour.
3. Stream the body into `BACKUPS` at `control-plane/<cell>/<timestamp>.sql`.
4. Delete dumps older than 30 days, by the object's own upload time.
5. With the off-site copy configured: read the new dump back from `BACKUPS`,
   stream it to the off-site bucket under the same key, then delete off-site
   dumps older than 30 days by their `LastModified`. The off-site prune runs
   only after a good copy, so a run of failed copies never ages out the last
   good off-site dump.

It no-ops unless `BACKUPS`, `CONTROL_PLANE_DATABASE_ID`,
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are all set, so a cell
without backups configured still ticks rather than erroring every six hours.

**The bucket must be private.** The dump contains every sealed admin token and
auth session in the cell. It is ciphertext — `SECRET_ENCRYPTION_KEY` seals the
tokens and is not in the dump — but treat the file as a credential.

### Off-site copy

Set all four Worker secrets (`wrangler secret put <NAME> --env <cell>`):

| Secret                             | Value                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `BACKUP_OFFSITE_ENDPOINT`          | The **other** account's R2 S3 API URL, `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_OFFSITE_BUCKET`            | A private bucket in that account                                                       |
| `BACKUP_OFFSITE_ACCESS_KEY_ID`     | An R2 API token in that account, Object Read & Write on that bucket only               |
| `BACKUP_OFFSITE_SECRET_ACCESS_KEY` | That token's secret                                                                    |

Any one unset → no off-site copy, exactly as before. The copy is signed with
SigV4 (`src/backup/offsite.ts`) and streamed as a multipart upload. Both
control-plane dumps and tenant snapshots go to the same bucket, under the same
keys as their primaries (`control-plane/…`, `tenant-backups/…`).

**A failed copy never fails or rolls back the primary backup.** Where to see it:

- Control-plane dumps: the six-hourly tick logs `[control-plane-backup] {…}`,
  as a warning with `offsite.status: "failed"` and a bounded reason (HTTP status
  and S3 error code) when the copy failed. The control plane keeps no row for
  its own dumps, so Workers Logs is the record. Alert on that line.
- Tenant snapshots: `offsiteStatus` / `offsiteError` on the `tenantBackups` row,
  shown as "off-site copy failed" next to the snapshot in the studio, plus a
  `[tenant-backup] … off-site copy failed` warning. The next snapshot copies
  again; a failed one is not retried on its own.

Retention follows the primary: control-plane dumps age out after 30 days;
a tenant snapshot dropped by plan retention or a project delete is deleted
off-site in the same pass, before its row. While the off-site account refuses a
delete, the row stays and the sweep retries next tick, so an off-site object of
a deleted project is never orphaned. Objects already off-site when the copy is
**un**configured are not pruned any more; delete them by hand.

Keep the off-site account's credentials out of the primary account, and treat
the off-site bucket exactly like `BACKUPS`: it holds the same sealed tokens.

### Restoring

#### Case 1 — a bad write, table, or migration (use Time Travel)

```bash
wrangler d1 time-travel info <DATABASE_NAME> --timestamp=<ISO8601>
wrangler d1 time-travel restore <DATABASE_NAME> --timestamp=<ISO8601>
```

Restore to just before the bad change. This is in place and needs nothing from
R2. Confirm the bookmark reads back what you expect with `info` before you run
`restore`.

#### Case 2 — the database is gone (use a dump)

1. **Take the newest dump.** Keys sort chronologically, so the last one wins:

    ```bash
    wrangler r2 object get <BUCKET>/control-plane/<cell>/<timestamp>.sql --file restore.sql
    ```

    If the cell's account is gone, take it from the off-site bucket instead,
    with wrangler logged in to **that** account (or any S3 client against
    `BACKUP_OFFSITE_ENDPOINT`):

    ```bash
    wrangler r2 object get <OFFSITE_BUCKET>/control-plane/<cell>/<timestamp>.sql --file restore.sql
    ```

    Then continue in a replacement account: the steps below are the same.

2. **Create a replacement database** and note the new uuid:

    ```bash
    wrangler d1 create <DATABASE_NAME>-restored
    ```

3. **Load the dump.** It carries both schema and data:

    ```bash
    wrangler d1 execute <DATABASE_NAME>-restored --remote --file restore.sql
    ```

4. **Repoint the Worker** — update the `database_id` in the `d1_databases`
   binding and in `CONTROL_PLANE_DATABASE_ID`, then deploy.

5. **Verify before declaring recovery**, in this order — each answer is
   worthless if the one above it is wrong:

    ```bash
    wrangler d1 execute <DATABASE_NAME>-restored --remote \
      --command "SELECT COUNT(*) FROM organizations; SELECT COUNT(*) FROM deployments WHERE status = 'live';"
    ```

    Then, against the running control plane: sign in, confirm the org switcher
    lists the orgs, open a project's Deployments tab, and confirm the studio can
    reach one live deployment's admin surface. That last one is the real check —
    it proves the sealed admin tokens survived the round trip, which a row count
    cannot tell you.

### Test this on a schedule

A backup nobody has restored is a hypothesis. Run case 2 against a scratch
database each quarter, from the newest real dump, and record the wall-clock time
it took — recovery time is the number an incident is judged on, and it is not
knowable from the code.

Two failure modes to watch for, both implied by how the sweep and the token
sealing work (this drill has not been run yet — when it is, record what it
actually found here):

- The dump restores, but the Worker still points at the dead database. Step 4 is
  the one people skip.
- Row counts match while the admin surface 401s, because
  `SECRET_ENCRYPTION_KEY` was rotated after the dump was taken. The sealed
  tokens are only as recoverable as the key that opens them: **back the key up
  separately, and never rotate it without taking a fresh dump afterwards.**

## Tenant data

### What is backed up

`src/backup/tenant-sweep.ts`, on the hourly trigger, snapshots each project
whose **live production** deployment has no successful snapshot in the last 24
hours — at most 20 per tick, most overdue first, one at a time. Previews are not
backed up: each has its own alias and its own disposable database.

A snapshot is the tenant runtime's own whole-deployment export
(`POST /_lunora/admin/export`, the same one `lunora cloud eject` reads), gzipped,
at `tenant-backups/<org>/<alias>/<timestamp>.ndjson.gz` in the private
`TENANT_BACKUPS` bucket. One `{"table", "doc"}` row per line, `_id` included.

The file is format 2: a `{"table":"$lunora","doc":{"format":2,"sections":[…]}}`
header line, then one `{"table", "doc"}` row per line, `_id` included, then the
sections — records under reserved `$`-prefixed table names. A file with no header
is format 1 (tables only, every snapshot taken before this change), and the
import reads both.

| Covered                                                                                                                                                                                                                                   | **Not** covered                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every table in the app's schema on every shard (the default DO and, with a shard registry, every `.shardBy()` shard)                                                                                                                      | Vectorize — the binding cannot list an index's vectors; re-embed with `backfillVectors` |
| `.global()` D1 tables                                                                                                                                                                                                                     | Queues, Hyperdrive-backed databases                                                     |
| `$auth` — the auth tables outside the schema (users, accounts, plugin tables; never live sessions or one-time tokens, so users sign in again after a restore, and never the auth audit log, which stays with its deployment), either mode | Runtime-internal state: scheduled jobs, CDC log, workflow state                         |
| `$kv` — every bound KV namespace: raw bytes, metadata, expiration (a value over 512 KiB in 512 KiB chunks)                                                                                                                                | Objects under `_lunora/` (resumable-upload state, restore staging)                      |
| `$storage` — every object in the app's `@lunora/storage` buckets, in 512 KiB base64 chunks, with type and metadata                                                                                                                        |                                                                                         |

A studio restore rewinds each section the snapshot's header declares, the way it
rewinds rows (below): the auth tables, every bound KV namespace and every storage
bucket end up holding exactly what the snapshot holds. A KV value or object of
more than one chunk is restored exactly as `lunora import` restores it — each
chunk sealed with AES-GCM under a key derived from the deployment's admin token,
checked against the SHA-256 the export wrote, a KV value (at most 25 MiB)
assembled in memory, an object up to 32 MiB in memory with one checksummed put
and a larger one through an R2 multipart upload in equal 5 MiB parts — with one
difference: the chunks are staged under the restore session's own prefix,
`_lunora/restore-session/<session>/<generation>/`, checked when the value's last
chunk is staged, and written only at commit. That prefix is disjoint from the
append import's `_lunora/restore/<target>/<session>/`, so neither import's sweep
of stale staging can delete the other's chunks. Objects under `_lunora/` are
Lunora's own and are never touched, apart from the restore's own staging.

`lunora import` (an append) writes sections append-only, the way it writes rows:
an auth row whose key or unique value exists, a KV key that exists (or has
expired since), or an object key that exists is left alone and counted as
already present. Its chunks are staged under `_lunora/restore/<target>/<session>/`
(in the object's bucket; a KV value's in the default bucket) and assembled when
the last one arrives; a restore that stops partway leaves its session, and the
next import deletes every such session over a day old when its header line
arrives, touching nothing else under `_lunora/`. Storage objects count toward
the 64 MiB cap below, so an app with a large bucket can outgrow snapshots it fit
before.

The export fails loudly rather than short: a shard it cannot reach, or a
`.shardBy()` table on an app with no shard registry, answers an error and the
attempt is recorded `failed` with that reason — never a partial snapshot marked
good. Snapshots stream to R2 as a multipart upload (8 MiB parts, one held in
memory at a time), so memory no longer limits a snapshot. It is capped at 4 GiB
compressed (`MAX_SNAPSHOT_BYTES`), because the export is the tenant's own code:
past the cap, or when the export breaks midway, the upload is aborted, no
object is left and the attempt is recorded `failed`.

Retention is per plan (`limits.backupRetention` in `src/billing/plans.ts`): the
newest **3** (free), **14** (pro) or **30** (enterprise) successful snapshots of
each project are kept; manual and pre-restore snapshots count toward it. When a
project is deleted — or its org is purged, which deletes its projects — the
sweep deletes its snapshots within the hour.

### Restoring from the studio

Project → Backups → **Restore** on a snapshot, then confirm (the confirm button
names the snapshot's time). Owner/admin only; audit-logged as
`tenant_backup.restore`. Refused while a backup or restore of that project is
running.

What it does, in order:

1. Takes a **pre-restore snapshot** of the current data. If that fails, nothing
   is restored.
2. **Stages** the snapshot: every batch (under the tenant's 1 MiB body limit)
   goes to `POST /_lunora/admin/import?mode=replace&stage=<session>`, all under
   one session. Staging changes nothing a reader sees: shard rows wait in each
   shard's staging table, `.global()` rows in D1's, auth and KV records on the
   root shard, sealed chunks under `_lunora/restore-session/<session>/…`.
   Every row is checked as it is staged, and a chunked value against its
   SHA-256 once its last chunk is.
3. **Commits** it: `POST /_lunora/admin/import/commit` swaps the whole snapshot
   in for every table in the schema (and the sections the header declares).

**A restore is a rewind.** Afterwards every table holds exactly what the
snapshot holds:

- A row deleted since the snapshot **comes back**, with its original `_id`.
- A row edited since the snapshot **gets its snapshot contents back**.
- A row created since the snapshot **is deleted**.
- A table the snapshot holds no rows for **is emptied**.

The same goes for the sections: an auth row, a KV key or a storage object created
since is removed, one changed since gets its snapshot contents back. Signed-in
sessions and one-time tokens are cleared with the auth tables, so users sign in
again after a restore.

**If staging fails** — a batch the tenant refuses, a row that does not validate
against the current schema, a shard it cannot reach — the restore **aborts the
session** (`POST /_lunora/admin/import/abort`) and is recorded `failed`: the
tenant was never touched. A session nobody commits or aborts expires an hour
after its last batch and is swept when the next one opens.

**The session fails closed.** Its state lives in one manifest on the tenant's
root shard, and every change to it is a compare-and-set. A staging batch is
opened before it writes and closed after, so a batch that never finished (the
request died) leaves the session uncommittable. A session with a refused row,
an unfinished batch, a batch that arrived after the commit's dry run, an abort
in progress, or a manifest that is missing, expired or unreadable refuses the
commit (409/404) before anything is written. Each session carries a generation,
so a session id reused after an expiry never picks up rows an earlier session
left behind, and no sweep deletes state it cannot read.

**The commit** first runs every shard's swap as a dry run in a transaction it
rolls back, so a row that would not land refuses the whole commit before any
shard is written; the restore then aborts and nothing changed. After that, how
atomic it is depends on the storage:

| Storage                    | Guarantee                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Each shard** (DO SQLite) | One Durable Object storage transaction: every overwrite and every delete lands, or none does. A shard records that it committed.                                                                                                                                                |
| **Across shards**          | Not one transaction — there is none across Durable Objects. The dry run leaves only infrastructure failures (a shard unreachable mid-commit); the commit then answers `partial`, and sending it again finishes the shards that had not committed.                               |
| **`.global()` D1 tables**  | D1 has no interactive transaction, and `batch()` covers only a statement list fixed up front, which the schema-aware writer cannot produce. Writes go first, deletes only once every write landed, so a failure leaves extra rows, never missing ones; a retry re-applies them. |
| **Auth tables**            | One transaction of the auth store: D1's `batch()`, or the auth Durable Object's storage transaction.                                                                                                                                                                            |
| **KV, storage objects**    | No multi-key transaction exists. Writes first, then deletes of what the snapshot does not hold; a retry re-applies them.                                                                                                                                                        |

The commit runs those in order — shards, `.global()`, auth, KV, storage — and the
root shard records each step that finished, so a retried commit skips what is
done and, once everything is, answers the same totals again. The studio retries a
`partial` commit up to three times; if it still has not finished, the restore is
recorded `failed` saying the tenant may be part-restored — restore the snapshot
again (it starts a fresh session) or restore the pre-restore snapshot.

The restore row records what it wrote (`restoreInserted`) and, per table, what it
removed (`restoreDeleted`; `$auth`, `$kv` and `$storage` for the sections), shown
next to the restore in the studio. Restores from before staged import recorded
`restoreConflicts` / `restoreRowErrors` instead; those rows still read.

The pre-restore snapshot preserves exactly what was there before, and restoring
it is a rewind too, so it **undoes** the restore. A tenant whose runtime predates
staged import is refused before a single row is sent — redeploy the project and
restore again.

### Downloading, and restoring by hand

Project → Backups → **Download** streams the `.ndjson.gz` to an owner/admin
(audit-logged as `tenant_backup.download`); the object itself is never public.
To load it into a Lunora deployment whose admin token you hold — a
self-hosted app, or a `lunora cloud eject` package (a Cloud project's admin
token is platform-owned, so for those use the studio restore):

```bash
gunzip acme-20260930T120000000Z.ndjson.gz
LUNORA_ADMIN_TOKEN=<its admin token> lunora import acme-20260930T120000000Z.ndjson --url <worker-url> --yes
```

`lunora import` appends: a row whose `_id` already exists is skipped. For a
rewind, either restore into an **empty** deployment (a fresh project, or after
clearing the tables), where append and replace are the same thing, or drive the
staged replace yourself — split the file into batches under 1 MiB, stage each,
then commit:

```bash
split -C 900000 acme-20260930T120000000Z.ndjson batch-
for batch in batch-*; do
  curl -fsS -X POST "<worker-url>/_lunora/admin/import?mode=replace&stage=manual-1" \
    -H "authorization: Bearer <its admin token>" -H "content-type: application/x-ndjson" \
    --data-binary @"$batch" || break
done
curl -X POST "<worker-url>/_lunora/admin/import/commit" \
  -H "authorization: Bearer <its admin token>" -H "content-type: application/json" \
  --data '{"session":"manual-1"}'
```

Check each staging answer's `errors` and `failed`; if any is non-empty, abort
(`/_lunora/admin/import/abort` with the same body) instead of committing. A
snapshot that fits one request can skip the session: `?mode=replace` without
`stage` stages and commits in that one call. `?tables=a,b` narrows a replace to
those tables; without it every table in the schema is replaced.

If the control-plane D1 is gone, the snapshots are still in R2:

```bash
wrangler r2 object get lunora-cloud-tenant-backups/tenant-backups/<org>/<alias>/<timestamp>.ndjson.gz --file snapshot.ndjson.gz
```

If the account is gone too, the same key is in the off-site bucket (when the
[off-site copy](#off-site-copy) is configured), read with wrangler logged in to
that account:

```bash
wrangler r2 object get <OFFSITE_BUCKET>/tenant-backups/<org>/<alias>/<timestamp>.ndjson.gz --file snapshot.ndjson.gz
```

### Known gaps

- **Same account unless the off-site copy is configured.** Without the
  `BACKUP_OFFSITE_*` secrets, snapshots live only in the cell's own account and
  an account-level loss takes them too. Restoring from the off-site copy is by
  hand (above); the studio restores from the primary bucket only.
- **Not one transaction across stores.** Each shard swaps atomically and the
  dry run refuses a bad row before anything is written, but shards, D1, KV and
  storage are committed one after another; a commit that fails part-way is
  finished by retrying it, not rolled back (table above).
- **Objects over 32 MiB need multipart.** A tenant Worker without
  `storageMultipartUpload` refuses such an object at staging, and the restore
  aborts with nothing changed.
- **Not covered:** Vectorize (table above).
- **The tenant export itself** still materialises every shard's rows inside
  the tenant Worker, so a very large tenant can exhaust the tenant side before
  the control plane's upload is the limit.
