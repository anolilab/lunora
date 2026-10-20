# @lunora-example/privacy

A task list that shows the whole `@lunora/privacy` surface: a user exports their
data, erases it, cancels a pending erasure, and sees their requests.

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
  restored. It starts `privacyRestore` with every subject the restored `tasks` table
  holds; the workflow reads the tombstones and erases those subjects again.
- **Operator view.** `lunora/admin.ts` holds the internal open list (`admin.open()`)
  and a retry of a failed request. They are what a Studio
  `privacyRequests` source calls. A failed erasure is retried by restarting its
  workflow, which is the only path that writes its tombstone. Extending a deadline is
  an operator decision with a reason, so no client function offers it.
- **Ownership.** The subject is always the caller's session (`lunora/subject.ts`), so
  a caller cannot open or cancel someone else's request.

## Layout

| File                                  | Role                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| `lunora/schema.ts`                    | `tasks`, the export parts table, rate limits, and `privacyExtension` |
| `lunora/tasks.ts`                     | the task list the subject owns                                       |
| `lunora/privacy.ts`                   | the dataset, `definePrivacy`, and the workflow handlers              |
| `lunora/privacy-ports.ts`             | the request store, dataset reader and file ports over `ctx.db`       |
| `lunora/privacy-tombstones.ts`        | the tombstone port over the `PRIVACY_TOMBSTONES` Durable Object      |
| `src/server/privacy-tombstones-do.ts` | the tombstone store, with its own SQLite outside the shard           |
| `lunora/admin.ts`                     | the operator's open list, retry and post-restore re-erasure          |
| `lunora/requests.ts`                  | the client functions, and the internal tick, sweep and `privacyPort` |
| `lunora/workflows.ts`                 | `privacyExport`, `privacyErasure` and `privacyRestore`               |
| `lunora/crons.ts`                     | the daily deadline check and the housekeeping sweep                  |
| `lunora/subject.ts`                   | the subject and session age, taken from the caller's session         |
| `lunora/limits.ts`                    | the rate limit every public write shares                             |
| `__tests__/privacy.test.ts`           | export, download, erasure, cancel and the session check              |

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/privacy run codegen
pnpm --filter @lunora-example/privacy run test
pnpm --filter @lunora-example/privacy run dev
```

Then open the URL the dev server prints (<http://localhost:5173> in the main checkout). Every privacy call needs a signed-in session, and
this example has no sign-in, so the page shows `UNAUTHENTICATED` until you add
`@lunora/auth` (see `examples/auth-playground`).

Erasure keys its tombstones with `PRIVACY_TOMBSTONE_SECRET`. Copy `.dev.vars.example` to
`.dev.vars` for local runs, and set the secret in production with
`wrangler secret put PRIVACY_TOMBSTONE_SECRET`. Without it an erasure fails with a clear
message instead of writing unkeyed tombstones.

## What is not wired up

- **Download links.** The package asks the host for a signed URL. This example has
  no object-storage binding, so `downloadUrl` returns a path under `/privacy/files/`
  that the Worker does not serve yet. The archive itself is stored in the
  `exportFiles` table, base64-encoded.
- **Starting workflows from the harness.** `ctx.workflows` is a stub in
  `@lunora/testing`, so the tests open requests with `privacyFor(ctx, identity)` directly
  and run the workflow handlers against the same `privacyPort` mutation a deployed
  workflow calls.
- **Erasure of the auth tables.** The example has no sign-in tables, so it does not
  declare an `authDataset`. An app that does should add one.
