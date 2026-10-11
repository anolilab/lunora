# @lunora-example/privacy

A task list that shows the whole `@lunora/privacy` surface: a user exports their
data, erases it, cancels a pending erasure, and sees the requests they have open.

> **Experimental.** The legal and tax values in `@lunora/privacy` are pending review.
> This example shows how the pieces fit; it is not a compliance checklist.

## What it demonstrates

- **Coverage.** `tasks.userId` makes `tasks` a table the build must classify. It is
  covered by the `tasks` dataset in `lunora/privacy.ts`. Drop that dataset and
  `lunora codegen` fails with `privacy_table_unclassified`.
- **Per-call ports.** `privacyFor(ctx)` binds the package's ports from the caller's
  context, because `ctx.db` exists only inside a call. Mutations pass their own
  `ctx`; the durable workflows pass theirs, and reach the database through `ctx.run`
  into the internal `privacyPort` mutation (`lunora/privacy-ports.ts`).
- **Export.** `requestExport` opens a request and starts `privacyExport`. The workflow
  collects each dataset as its own step, then writes a ZIP and a PDF summary.
- **Erasure.** `requestErasure` opens a request in a 14-day grace and starts
  `privacyErasure`. The workflow sleeps through the grace, erases the rows one dataset
  at a time, then verifies that every table reads zero. A `cancelRequest` during the
  grace stops it.
- **Deadlines.** A daily cron runs the internal `privacyTick`, which lists requests
  due within seven days and any already overdue.
- **Ownership.** The subject is always the caller's session (`lunora/subject.ts`), so
  a caller cannot open or cancel someone else's request.

## Layout

| File                        | Role                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `lunora/schema.ts`          | `tasks`, the export parts table, and `privacyExtension`                 |
| `lunora/privacy.ts`         | the dataset, `definePrivacy`, and the workflow handlers                 |
| `lunora/privacy-ports.ts`   | the ports over `ctx.db`, and the wire format for workflow steps         |
| `lunora/privacy-api.ts`     | the client functions and the internal `privacyTick` and `privacyPort`   |
| `lunora/workflows.ts`       | `privacyExport` and `privacyErasure`, built from the package's handlers |
| `lunora/crons.ts`           | the daily deadline sweep                                                |
| `__tests__/privacy.test.ts` | export, download, erasure, cancel and the session check                 |

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/privacy run codegen
pnpm --filter @lunora-example/privacy run test
pnpm --filter @lunora-example/privacy run dev
```

Then open <http://localhost:5173>. Every privacy call needs a signed-in session, and
this example has no sign-in, so the page shows `UNAUTHENTICATED` until you add
`@lunora/auth` (see `examples/auth-playground`).

## What is not wired up

- **Download links.** The package asks the host for a signed URL. This example has
  no object-storage binding, so `downloadUrl` returns a path under `/privacy/files/`
  that the Worker does not serve yet. The archive itself is stored in the
  `exportFiles` table, base64-encoded.
- **Starting workflows from the harness.** `ctx.workflows` is a stub in
  `@lunora/testing`, so the tests open requests with `privacyFor(ctx)` directly and run
  the workflow handlers against the same port dispatcher a deployed workflow uses.
- **Erasure of the auth tables.** The example has no sign-in tables, so it does not
  declare an `authDataset`. An app that does should add one.
