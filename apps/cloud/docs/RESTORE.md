# Control-plane restore runbook

The control-plane D1 is the one store in the platform whose loss is
unrecoverable rather than inconvenient. Tenant data lives in each tenant's own
Durable Object and is not in scope here — what is only in this database is
**which cell a tenant is on, which script serves it, and the sealed admin token
that reaches it**. Without it the tenant workers keep serving traffic and
nothing can be administered, billed, deployed, or torn down.

## What protects it

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

## What the sweep does

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

## Restoring

### Case 1 — a bad write, table, or migration (use Time Travel)

```bash
wrangler d1 time-travel info <DATABASE_NAME> --timestamp=<ISO8601>
wrangler d1 time-travel restore <DATABASE_NAME> --timestamp=<ISO8601>
```

Restore to just before the bad change. This is in place and needs nothing from
R2. Confirm the bookmark reads back what you expect with `info` before you run
`restore`.

### Case 2 — the database is gone (use a dump)

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

## Test this on a schedule

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
