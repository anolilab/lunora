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

| Layer                          | Recovers from                                 | Does not recover from                      |
| ------------------------------ | --------------------------------------------- | ------------------------------------------ |
| **D1 Time Travel** (automatic) | A bad write, a dropped table, a bad migration | Losing the database or the account         |
| **This backup sweep**          | Losing the database                           | Losing the **account** — see the gap below |

Time Travel is Cloudflare's, needs no code, and covers 30 days. Reach for it
first: it is faster, exact to the second, and does not involve a dump at all.
The sweep exists because Time Travel history lives inside the database it
protects, so a deleted or compromised account takes the history with it.

> **Known gap.** The dump is written to R2 **in the same account**. A Worker's
> R2 binding cannot address another Cloudflare account, so a second copy in
> another cell needs R2's S3 API and a credential for that account. Until that
> lands, an account-level loss is not covered. Do not describe this as
> off-account DR.

### What the sweep does

`src/backup/sweep.ts`, on the existing six-hourly cron trigger (a fourth trigger
is not available — Cloudflare caps a Worker at three).

1. `POST /d1/database/<id>/export` and poll to completion.
2. `GET` the presigned URL it answers — valid for one hour.
3. Stream the body into `BACKUPS` at `control-plane/<cell>/<timestamp>.sql`.
4. Delete dumps older than 30 days, by the object's own upload time.

It no-ops unless `BACKUPS`, `CONTROL_PLANE_DATABASE_ID`,
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are all set, so a cell
without backups configured still ticks rather than erroring every six hours.

**The bucket must be private.** The dump contains every sealed admin token and
auth session in the cell. It is ciphertext — `SECRET_ENCRYPTION_KEY` seals the
tokens and is not in the dump — but treat the file as a credential.

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

| Covered                                                                                                              | **Not** covered                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Every table in the app's schema on every shard (the default DO and, with a shard registry, every `.shardBy()` shard) | Files in R2 / `ctx.storage` — rows that reference them are, the bytes are not |
| `.global()` D1 tables                                                                                                | KV, Vectorize, Queues, Hyperdrive-backed databases                            |
|                                                                                                                      | Tables the schema does not declare (e.g. auth tables owned by an adapter)     |
|                                                                                                                      | Runtime-internal state: scheduled jobs, CDC log, workflow state               |

The export fails loudly rather than short: a shard it cannot reach, or a
`.shardBy()` table on an app with no shard registry, answers an error and the
attempt is recorded `failed` with that reason — never a partial snapshot marked
good. Snapshots over 64 MiB compressed are refused (the control plane assembles
them in memory before the upload).

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
2. Replays the chosen snapshot through the tenant's `POST /_lunora/admin/import`
   in batches under its 1 MiB body limit.

**The import is append-only, so a restore is not a rewind.**

- A row deleted since the snapshot **comes back**, with its original `_id`.
- A row that still exists **keeps its current contents** — an edit made since
  the snapshot is not reverted (it counts as "already present").
- A row created since the snapshot **stays**.
- A row that no longer validates against the current schema is **rejected** and
  counted; the rest still land.

Re-running a restore is safe (already-present rows are skipped), which is the
remedy for a partial one (reported as such when a batch could not reach a
shard). The pre-restore snapshot preserves exactly what was there before; it is
downloadable, but restoring it would not undo the restore — rows the restore
brought back would stay. To truly go back, reconcile by hand from the two files.

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

`lunora import` is the same append-only import. For a real rewind, restore into
an **empty** deployment (a fresh project, or after clearing the tables), where
append and replace are the same thing.

If the control-plane D1 is gone, the snapshots are still in R2:

```bash
wrangler r2 object get lunora-cloud-tenant-backups/tenant-backups/<org>/<alias>/<timestamp>.ndjson.gz --file snapshot.ndjson.gz
```

### Known gaps

- **Same account.** Like the control-plane dump, snapshots live in the cell's
  own account; an account-level loss takes them too.
- **No point-in-time rewind.** Needs a replace-mode import in the runtime.
- **Not covered:** R2 objects, KV, Vectorize (table above).
- **Size ceiling** of 64 MiB compressed per snapshot until uploads go multipart.
