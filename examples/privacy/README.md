# @lunora-example/privacy

A task list and its invoices that show the whole `@lunora/privacy` surface: a user exports their
data, erases it, cancels a pending erasure, sees their requests, and downloads the archive.

> **Experimental.** The legal and tax values in `@lunora/privacy` are pending review.
> This example shows how the pieces fit; it is not a compliance checklist.

## What it demonstrates

- **Coverage.** `tasks.userId` makes `tasks` a table the build must classify. It is
  covered by the `tasks` dataset in `lunora/privacy.ts`. Drop that dataset and
  `lunora codegen` fails with `privacy_table_unclassified`; an exclusion with a blank
  reason fails with `privacy_exclusion_unexplained`.
- **Per-call ports and identity.** `privacyFor(ctx, identity)` binds the package's
  ports from the caller's context, because `ctx.db` exists only inside a call, and the
  subject's identity from its session. The durable workflows bind theirs and reach the
  database through `ctx.run` into the internal `privacyPort` mutation, which runs the
  package's dispatcher (`@lunora/privacy/workflow`) over the app's own ports.
- **Export.** `requestExport` opens a request and starts `privacyExport`. The workflow
  collects each dataset as its own step, then writes a ZIP and a PDF summary.
- **Download.** `downloadLink` returns a link to the finished archive. The link is an HMAC
  over the file's key and expiry, signed with `PRIVACY_FILE_SECRET`, and `lunora/http.ts`
  serves it at `/privacy/files` once the signature and expiry check out. Every refusal is
  the same 404, so a forged link, an expired one and a missing file look alike.
- **Retention.** `invoices` carry a `de.voucher` directive. Erasure keeps each invoice
  under its statutory period, writing it to the package's `privacy_archive` rather than
  deleting it, and the daily sweep purges the kept row once its period has ended.
- **Erasure.** `requestErasure` opens a request in a 14-day grace and starts
  `privacyErasure`. The workflow sleeps through the grace, erases the rows one dataset
  at a time, then verifies that every table reads zero. A `cancelRequest` during the
  grace stops it.
- **Deadlines and housekeeping.** A daily cron runs the internal `privacyTick`, which
  lists requests due within seven days and any already overdue, and `privacySweep`,
  which expires finished exports past their download window and purges the archive.
- **Tombstones outside the shard.** A completed erasure records an HMAC of the subject
  id in the `PRIVACY_TOMBSTONES` Durable Object (`src/server/privacy-tombstones-do.ts`),
  not in the shard. `lunora backup pitr --restore` rolls the shard back, and a tombstone
  stored there would be rolled back with the rows it exists to re-erase. Only the
  erasure workflow reaches the store (through `ctx.env`), so an erasure run from a
  mutation is refused rather than completed without its tombstone.
- **After a restore.** Call the internal `admin:restorePrivacyErasures` once the shard is
  restored. It starts `privacyRestore` with every subject the restored `tasks` and `invoices`
  tables hold, so a subject with only invoices is included. The workflow reads the tombstones and
  erases those subjects again.
- **Operator view.** `lunora/admin.ts` holds the internal open list (`admin.open()`)
  and a retry of a failed request. They are what a Studio
  `privacyRequests` source calls. A failed erasure is retried by restarting its
  workflow, which is the only path that writes its tombstone. Extending a deadline is
  an operator decision with a reason, so no client function offers it.
- **Sign-in tables.** `authDataset()` covers better-auth's `user`, `session` and `account` rows,
  which live in D1 (`lunora/auth.ts`, `lunora/privacy-auth.ts`). An export collects them without the
  password hash, and an erasure deletes them. The workflow reads them through `ctx.env.DB`.
- **Ownership.** The subject is always the caller's session (`lunora/subject.ts`), so
  a caller cannot open or cancel someone else's request.

## Layout

| File                                          | Role                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `lunora/schema.ts`                            | `tasks`, `invoices`, the export parts table, rate limits, and `privacyExtension` |
| `lunora/tasks.ts`                             | the task list the subject owns                                                   |
| `lunora/privacy.ts`                           | the datasets (`tasks`, `billing`), `definePrivacy`, and the workflow handlers    |
| `lunora/privacy-ports.ts`                     | the request store, dataset reader and file ports over `ctx.db`                   |
| `lunora/privacy-tombstones.ts`                | the tombstone port over the `PRIVACY_TOMBSTONES` Durable Object                  |
| `lunora/privacy-files.ts`                     | the download link: signing, checking, and the response it writes                 |
| `lunora/http.ts`                              | the `/privacy/files` route that serves an archive to its link                    |
| `src/server/privacy-tombstones-do.ts`         | the tombstone store, with its own SQLite outside the shard                       |
| `lunora/admin.ts`                             | the operator's open list, retry and post-restore re-erasure                      |
| `lunora/requests.ts`                          | the client functions, and the internal tick, sweep and `privacyPort`             |
| `lunora/workflows.ts`                         | `privacyExport`, `privacyErasure` and `privacyRestore`                           |
| `lunora/crons.ts`                             | the daily deadline check and the housekeeping sweep                              |
| `lunora/subject.ts`                           | the subject and session age, taken from the caller's session                     |
| `lunora/limits.ts`                            | the rate limit every public write shares                                         |
| `__tests__/privacy.test.ts`                   | export, download, erasure, cancel and the session check                          |
| `__tests__/privacy-files.test.ts`             | the download link: signing, expiry, tampering and the response                   |
| `__tests__/download-route.test.ts`            | `/privacy/files` through the Worker, and the internal read it makes              |
| `__tests__/retention.test.ts`                 | retained invoices through erasure, and the sweep's purge                         |
| `__tests__/generated-workflows.test.ts`       | the generated Workflow entrypoints bind the privacy handlers                     |
| `__tests__/workerd/lifecycle.workerd.test.ts` | the lifecycle over a Durable Object's SQLite, with retention and expiry          |

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/privacy run codegen
pnpm --filter @lunora-example/privacy run test
pnpm --filter @lunora-example/privacy run dev
```

Then open the URL the dev server prints (<http://localhost:5173> in the main checkout). Create an
account on the page: sign-in is email and password, through `@lunora/auth` over a D1 database
(`DB` in `wrangler.jsonc`). Every privacy call needs that session.

Erasure keys its tombstones with `PRIVACY_TOMBSTONE_SECRET`. Copy `.dev.vars.example` to
`.dev.vars` for local runs, and set the secret in production with
`wrangler secret put PRIVACY_TOMBSTONE_SECRET`. Without it an erasure fails with a clear
message instead of writing unkeyed tombstones.

Download links are signed with `PRIVACY_FILE_SECRET`, set the same way
(`wrangler secret put PRIVACY_FILE_SECRET`). Without it no link can be minted, and an
existing link answers 404.

Sign-in signs its session cookie with `AUTH_SECRET`, set the same way
(`wrangler secret put AUTH_SECRET`). The Worker refuses to start sign-in without it.

Workflows call back into the Worker through its public origin. Set it for a deploy with
`wrangler secret put LUNORA_ORIGIN_URL`, and for local runs in `.dev.vars`. Without it an export or an
erasure fails with a clear message.

## What is not wired up

- **Object storage.** The archive is stored in the `exportFiles` table, base64-encoded,
  because the example has no object-storage binding. A production app that stores files
  in R2 would sign its links with `@lunora/storage` instead.
- **Starting workflows from the harness.** `ctx.workflows` is a stub in
  `@lunora/testing`, so the tests open requests with `privacyFor(ctx, identity)` directly
  and run the workflow handlers against the same `privacyPort` mutation a deployed
  workflow calls.
- **Retrying a failed export.** An operator's retry runs an export inline, inside a
  mutation, and a mutation has no D1 binding. An export whose sign-in tables are part of it
  therefore fails again on retry, and the event log records why. Only the workflow reaches
  those tables. Erasure retries restart the workflow and are unaffected.
