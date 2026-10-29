# Plan 468 — `@lunora/privacy`: reusable data-subject-rights machinery (export, erasure, retention holds)

**Baseline:** `b8f2cdd84` (origin/alpha, 2026-10-11)
**Status:** IN PROGRESS (Phase 0). Decisions D1, D2 (voucher period), D3, D4, D5 (format) and D6 are
recorded in §9. Still open: confirmation of the PDF library choice (D5), the statutory 8-year voucher rule (TR), and every
LR/TR item in §10. Phase 1 starts only after the Phase 0 gate in §7 is green. Every row marked **LEGAL REVIEW** needs sign-off from a German data
protection lawyer, and every row marked **TAX REVIEW** needs a Steuerberater, before the matching
default ships. Nothing in this plan is legal advice.

**Update 2026-10-26.** The example (`examples/privacy`) now covers the download (a signed `/privacy/files`
route, mounted on the Worker, over the `exportFiles` table), a retained table (`invoices` under `de.voucher`, archived to
`privacy_archive` and purged by the sweep), and export expiry, all on workerd. The generated workflow
entrypoints for the per-call handlers are checked by `__tests__/generated-workflows.test.ts`, which closes
the §4.2 check. The summary PDF was re-measured on workerd with `@cantoo/pdf-lib` (600 datasets: 37 pages,
96 KB, 300 ms; the earlier 40-page figure was for `pdf-lib` 1.17.1, so the two are not like-for-like).
The example now declares `authDataset()` over better-auth's D1 tables (`user`, `session`, `account`). The
workflow reads and erases them through `ctx.env.DB`. Still open: every LR/TR item in §10, and an admin
retry of an export that includes those tables, which is recorded as failed (a mutation has no D1 binding).

## 0. Headline finding

Every Lunora app that handles EU users has to provide data export (GDPR Art. 15 and 20) and account
erasure (Art. 17), and today each one builds this by hand. The two existing hand-built app
implementations on this framework (nearly identical to each other) and one older
Convex-based implementation share five defects. A package should make these defects impossible
rather than copy them:

1. **The Art. 12(3) deadline is computed in the wrong unit and enforced the wrong way.** All three
   use a fixed 30 days, but the law says one calendar month. A cron then marks overdue requests
   `failed`. That records a breach instead of preventing one. There is no extension path
   (Art. 12(3) sentence 2), no Art. 12(4) refusal path, and no warning before the deadline.
2. **Nothing catches a forgotten table.** Erasure is a hand-written list of about 50 workflow steps.
   A new table that is not added to the list survives erasure silently, and a later step cannot
   detect it. Letting one central module delete every other module's rows also means accepting
   a large number of `cross_module_table_write` lint findings.
3. **Exported data travels through durable step results.** Cloudflare Workflows and celld both cap
   one step's persisted result at 1 MiB, so a heavy user's export fails. Collectors also truncate
   rows to stay under that cap (for example, only the 50 newest runs of a task). A truncated export
   is an incomplete Art. 15 answer.
4. **No legal retention rules are modelled in the three prior-art apps.** None of them encodes HGB
   §257, AO §147, or BDSG §34/§35. PR #85 does encode some retention periods; see §1. None names an Art. 17(3) exception. None separates Art. 15 data from Art. 20 data.
   The export is labelled "portability" but is really an access copy.
5. **Retried steps repeat side effects.** Emails, notifications and audit rows are written with a
   raw `step.do` plus `ctx.run` and no `dedupId`. When a step is retried, they are sent or written
   twice.

The framework already provides most of what the fix needs, as §2 lists. The new package is mostly
composition: tables, policy, workflows, and a coverage check.

## 1. Current state (audit)

**Prior art.** These are generic descriptions; the source apps are not named.

- **Module layout.** A central `gdpr/` module owns the request, consent and audit tables. Each
  feature module adds a `<module>/gdpr.ts` file with `collectXForExport` (an internal query) and
  `deleteUserX` (an internal mutation returning `{ hasMore }`, at most 100 rows per table per call,
  idempotent). These are wired by hand into `workflows/export-workflow.ts` (17 `collect-*` steps)
  and `workflows/deletion-workflow.ts` (about 50 steps).
- **Erasure ordering.** The order is load-bearing and only written down in comments:
    1. Stop anything that writes new data, such as scheduled tasks and eval runs. Otherwise a task
       round creates a row behind a step that has already run.
    2. Revoke external grants while the tokens still exist.
    3. Delete content: children before parents, documents before threads.
    4. Delete identity and auth records last.
    5. Purge document history, because every audited delete above writes a snapshot.
    6. Notify the analytics processor.
    7. Send the confirmation email.
    8. Minimise the remaining audit records.
- **Background-writer guard.** `isAccountDeletionUnderway(ctx, userId)` is a guard that background
  writers must call. Nothing enforces that they do.
- **Re-authentication.** Erasure requires a session younger than 24 hours, and an impersonated
  session is refused. This is a sound Art. 12(6) control; keep it.
- **Sequential deletes.** Deletes inside a batch run one at a time. Running them in parallel nests
  audit triggers past the trigger-recursion limit. Workerd also caps `TRIGGER_DEPTH` at 10 (see
  `packages/shard-engine/__tests__/workerd-sql-limits.test.ts`).
- **Export format.** One JSON object with hard-coded top-level keys. It is uploaded to storage,
  downloaded through a URL valid for 7 days, and an expiry cron deletes the file.
- **Wrong legal label.** The compliance checklist ticks "Article 30: records of processing" for an
  audit log. Art. 30 requires a record of processing activities (purposes, categories, recipients,
  retention), not an event log. The audit log is accountability evidence under Art. 5(2) and 24.

**Framework seams relevant to this plan.** All were read on the baseline.

- **`defineComponent`** (`packages/server/src/plugin.ts:351`) and `defineSchemaExtension`. A package
  ships prefixed tables (`privacy_requests`) and registered functions, and the app re-exports them.
  `@lunora/agent` does exactly this (`packages/agent/src/component.ts`, string dispatch paths in
  `packages/agent/src/paths.ts`).
- **`defineModule({ tables })`** (`packages/server/src/module.ts`) is metadata only, and it feeds the
  `cross_module_table_write` lint (`packages/advisor/src/lints/static/cross-module-table-write.ts`).
  The same lint treats an installed component as the owner of its own tables.
- **`.ownedBy(field)`** (`packages/server/src/schema.ts:282`) survives at runtime as
  `TableDefinition.ownerField` (`packages/server/src/types.ts:401`). It is the strongest signal that
  a table holds one user's data. Codegen's `TableIR` does not carry it yet
  (`packages/codegen/src/ir.ts:240-283`).
- **`.softDelete()`** (`schema.ts:333`). A plain `delete()` only sets a marker, so erasure must use
  hard deletes. `deleteAll(table, { hard: true })` and `wipeShard({ exclude })`
  (`packages/server/src/types.ts:1300`, `:1424`) are the uncapped erasure primitives.
  `deleteMany`/`deleteWhere` throw above 500 rows. `wipeShard` skips `.global()` tables.
- **Workflows.** `defineWorkflow` must be declared in `lunora/workflows.ts`. Its argument must be an
  object literal, or a local `const` holding one (`packages/codegen/src/discover/workflows.ts:241`).
  A `handler:` reference is followed through imports to read step names
  (`discover/handler-reference.ts`). A handler coming from a package `.d.ts` resolves to no function
  body, so the workflow still registers, just without a static step list. **Phase 0 spike: confirmed
  for a handler; see the Phase 0 results in §7.**
- **`ctx.run(ref, args, { dedupId, shardKey })`** (`packages/workflow/src/types.ts:232`).
  `ctx.runStep` pins a retry-stable dedup id. A `FunctionReference` is just
  `{ __lunoraRef: "module:fn" }` (`shared/function-reference.ts`), so the package can dispatch to its
  own re-exported functions by path, the same way the agent loop does.
- **Workflow limits.** On Cloudflare (developers.cloudflare.com/workflows/reference/limits, checked
  2026-10-11):
    - 1 MiB of persisted state per step.
    - 10,000 steps by default, configurable up to 25,000. The Free plan allows 1,024.
    - 30 s CPU per step by default.
    - Completed instances are retained for 30 days.

    celld has the same 1 MiB cap and replays non-step code from the start
    (`packages/platform/src/capabilities/celld.ts:225`).

- **Storage** (`packages/server/src/storage/context.ts`). Offers `store`, `getSignedUrl(key,
{ expiresInSeconds })`, and multipart upload (`createMultipartUpload` / `resumeMultipartUpload`).
- **Auth admin** (`packages/auth/src/admin.ts:352-356`). Provides `removeUser` and
  `revokeUserSessions`. better-auth rows live in the auth store (D1 or DO), outside the app schema.
- **Built-in component tables that hold personal-data copies.** `document-history`
  (`packages/server/src/document-history.ts`, with its own `vacuum`), `action-cache`, `presence`.
  Outside the schema, the CDC changelog, the R2 CDC archive, `lunora backup` snapshots, and Durable
  Object PITR also hold copies.
- **Scheduling.** `ctx.scheduler.runAt` is `emulated` on all three hosts. Declared crons are
  `unsupported` on node (`packages/platform/src/capabilities/node.ts:120`).

**Open PR #85 (`apps/cloud`, this repo, not on `alpha`).** It is not one of the prior-art apps; it is
the cloud control plane (PR #85, head `claude/cloud-platform-dx-ojvkmu`). The relevant parts are:

- `exportMine` in `apps/cloud/lunora/account.ts`: a per-account export.
- `apps/cloud/lunora/retention.ts`: anonymised payment and subscription rows are kept 10 years
  (citing AO §147 and HGB §257, with the 8-year change noted as unconfirmed, so the longer period
  is used); audit entries 3 years (BGB §195); payment webhook de-duplication 90 days.
- A 30-day organisation deletion grace (`apps/cloud/src/lib/deletion-retention.ts`).
- Account deletion that requires the current password (`apps/cloud/lunora/auth-ui/core/delete-account.ts`).

Decisions D2 and D3 follow it. Its whole-deployment backup and restore (`packages/runtime/src/export-sections.ts`)
is not a per-subject export. The PR is still open, so re-check it before implementing.

## 2. Existing seams (do not reinvent)

| Need                                  | Use                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Tables and functions shipped to apps  | `defineComponent` + `defineSchemaExtension` (`@lunora/server`)                        |
| Durable steps, crash resume, dedup    | `@lunora/workflow` `defineWorkflow`, `ctx.runStep`, `ctx.run(…, { dedupId })`         |
| Export file + time-limited download   | `ctx.storage.store` / multipart, `getSignedUrl`                                       |
| Deadlines, expiry, grace period       | `ctx.scheduler.runAt` (all hosts); declared crons only as a backstop                  |
| Erasure primitive                     | `ctx.db.deleteAll(t, { hard: true })`, `wipeShard({ exclude })`                       |
| Identity, re-auth, session revocation | `ctx.auth`, `createAuthAdmin().revokeUserSessions/removeUser` (`@lunora/auth`)        |
| Owner column                          | `.ownedBy(field)` → `TableDefinition.ownerField`                                      |
| Static checks                         | `@lunora/advisor` lint fed by `@lunora/codegen` (Phase 3)                             |
| Errors                                | `LunoraError` + catalog codes (`@lunora/errors`)                                      |
| Email / push                          | **Not a dependency.** App hooks; apps call `@lunora/mail`/`@lunora/notify` themselves |

Mail is a hook rather than a dependency for three reasons. `mail` is `unsupported` on node. Apps
already have their own templates. And a hard dependency would force Resend on apps that use another
mail transport.

## 3. The behavioural contract to preserve

These are new contracts. They are frozen from the first release because in-flight durable instances
depend on them.

1. **Step names are a durable-log contract.** The format is `privacy/v1/<phase>/<datasetId>[/<n>]`.
   Dataset ids must be unique, which `definePrivacy` asserts. Renaming a dataset id while an
   instance is in flight is a breaking change. A changeset that renames one must be announced in the
   commit body.
2. **Erasure batch contract.** Each call deletes at most `batchSize` rows (default 100) per table and
   returns `{ hasMore }`. It is idempotent: re-running a committed batch deletes nothing new. Deletes
   inside a batch run sequentially.
3. **Collect contract.** `collect(ctx, { subjectId, cursor }) → { rows, cursor | null }`. Paging is
   cursor-based. A collector must never truncate. Each page is written to storage inside its own
   step, and the step returns only `{ key, count, sha256 }`.
4. **Export archive layout** (`manifest.json` `formatVersion: 1`) is described in §4.6. Consumers
   may parse it, so changing it bumps `formatVersion`.
5. **Workflow instance id equals the request id.** Creating the workflow twice is a no-op
   (`isDuplicateInstanceError`).
6. **Hooks are at-least-once.** Hooks are app code calling external services, so a crash inside the
   notify step runs the callback again. Each hook receives an `idempotencyKey`
   (`<requestId>:<stepName>`) to pass to its mail or notification provider. The package guarantees
   exactly-once only for its own database writes.

## 4. Design decisions

### 4.1 Name, scope, boundary

**Decided: `@lunora/privacy`** (maintainer, 2026-10-11), with `gdpr`, `dsgvo` and `dsar` as package keywords. The npm name was checked and is free.
`@lunora/gdpr` was rejected for these reasons:

- **The machinery is not specific to the GDPR.** The request lifecycle, data inventory, export,
  erasure, retention holds and deadlines also serve UK GDPR, Swiss revFADP and CCPA access and
  deletion requests.
- **The German rules are not GDPR rules.** HGB §257 and AO §147 are commercial and tax law. A
  package named after one regulation would misstate its own contents.
- **Jurisdiction rules ship as policy presets** at subpaths: `@lunora/privacy/eu` and
  `@lunora/privacy/de`. The core is jurisdiction-neutral.

`@lunora/data-rights` was the fallback and is no longer under consideration. Consent is **out of scope** here: it is a client and UI concern, and existing
apps use a separate library for it.

**Not a subpath of an existing package:**

- `@lunora/server` would gain a dependency on `@lunora/workflow`, and its zero-config core does not
  need retention law.
- `@lunora/auth` is identity on better-auth, and erasure reaches far beyond it.
- `@lunora/workflow` is a generic engine.
- The package ships tables, two workflows and policy data, so it needs its own release cadence. It
  starts on the **experimental** tier.

**The package owns:**

- The `privacy_*` tables.
- The request lifecycle and the Art. 12 clock.
- The two workflow handlers.
- The generic owner-column collector and eraser.
- Archive assembly and signed download.
- The retention-hold registry and the rule presets.
- The coverage check.
- The Art. 15 manifest and an Art. 30 inventory export.
- Built-in contributions for framework-owned copies: auth, document history, action cache, storage
  objects.

**The app owns:**

- Per-module dataset declarations, colocated with the tables.
- Custom collectors and erasers for tables without an owner column.
- External side effects, through hooks.
- Email and notification content.
- The UI.
- Choosing retention rule values, recording which processors it uses, and its privacy policy text.

### 4.2 App-side integration

There are four touch points. Phase 0 confirms the codegen constraints behind them.

**Port binding is per invocation (decided with the example app).** `definePrivacy(config)` bound
`data`, `files`, `store`, `tombstones`, `now` and `newId` when it was called. A Lunora `ctx.db` exists only
inside a function invocation, so those ports cannot be built at module load. The change: `ports` is a
function of the invocation's context, and `definePrivacy` returns a factory, `privacyFor(ctx)`, that binds
the ports for one call and returns the same API:

```ts
export const privacyFor = definePrivacy({ datasets, presets, exclude, ports: (ctx) => ({ data, files, store, now, newId, tombstones }) });
// inside a mutation
await privacyFor(ctx).requestExport({ subjectId });
```

Reason: the smallest change that keeps one API. The alternatives were a second, port-free `Privacy` object
that every call site must pass ports to, or a module-level `ctx` that does not exist. The old static
`PrivacyConfig` is removed rather than kept beside the factory, because this is a pre-release branch. A
workflow context has no `ctx.db`, so its `ports` reach the data through `ctx.run` into an internal
function. The example app is the reference for that.

**The requests table keys rows by the id the package hands out.** The table had no column for that
id, so an app's store port could not find a request again. It now has a `requestId` column with a
`byRequestId` index. Found while building the example. The app's `_id` cannot serve, because the
package mints the id before the insert.

**Open for the maintainer.** `TombstonePort.keys()` returns every tombstone, so an app reads the whole
table on each restore. A membership check per restored subject would let the app use an index.

**1. Merge the extension into the schema.** The table set is static and independent of
configuration, so there is no cycle with step 2.

```ts
// lunora/schema.ts
import { privacyExtension } from "@lunora/privacy";
export default defineSchema({ ... }).extend(privacyExtension);
```

**2. Define the privacy configuration, and declare its functions in the app.**

```ts
// lunora/privacy.ts
import { authDataset, definePrivacy, documentHistoryDataset } from "@lunora/privacy";
import { eu } from "@lunora/privacy/eu";
import { germany } from "@lunora/privacy/de";
import schema from "./schema";
import { billingData } from "./billing/privacy";
import { tasksData } from "./tasks/privacy";

export const privacy = definePrivacy({
    schema,
    presets: [eu(), germany()], // §4.4 defaults; a preset sets policy values and named retention rules, each overridable
    subject: { shardKey: (subjectId) => subjectId }, // where the subject's own rows live
    datasets: [tasksData, billingData, authDataset(), documentHistoryDataset()],
    exclude: { featureFlags: "Operator configuration; contains no personal data" },
    workflows: { export: "privacyExport", erasure: "privacyErasure" }, // the default; must match lunora/workflows.ts
    hooks: {
        requestReceived: async (ctx, request) => {
            /* acknowledgement mail */
        },
        exportReady: async (ctx, request) => {
            /* mail with link to the privacy page */
        },
        erasureCompleted: async (ctx, { email }) => {
            /* confirmation to the captured email */
        },
        deadlineApproaching: async (ctx, request) => {
            /* page the operator */
        },
    },
});
```

The functions are builder calls in the app, in their own file, so codegen registers them. The
package supplies only the handlers. The args validators are declared here too, because codegen cannot
read a validator that a package declares.

```ts
// lunora/privacy-api.ts
import { internalMutation, mutation, query, v } from "@lunora/server";

import { privacy } from "./privacy";

export const requestExport = mutation({ args: { subjectId: v.string() }, handler: privacy.handlers.requestExport });
export const requestErasure = mutation({ args: { subjectId: v.string() }, handler: privacy.handlers.requestErasure });
export const cancelRequest = mutation({ args: { requestId: v.string() }, handler: privacy.handlers.cancelRequest });
export const myRequests = query({ args: {}, handler: privacy.handlers.myRequests });
export const exportDownloadUrl = query({ args: { requestId: v.string() }, handler: privacy.handlers.exportDownloadUrl });
export const privacyRun = internalMutation({
    args: { dataset: v.string(), operation: v.string(), cursor: v.optional(v.string()) },
    handler: privacy.handlers.run,
});
export const privacyTick = internalMutation({ args: {}, handler: privacy.handlers.tick });
export const privacyAdmin = internalMutation({ args: {}, handler: privacy.handlers.admin });
```

**Why not `export const { … } = privacy.functions`.** A package that ships declarations only makes
codegen drop the destructured functions without a diagnostic. The Phase 0 re-plan tested this
(`privacy-functions.test.ts`): a builder call in the app registers, and the destructured form does not.
The package also needs a reference to `privacyRun` to dispatch steps. It does not import `_generated`.
The app passes its generated reference in config instead, as a thunk, so the module cycle stays lazy:
`definePrivacy({ …, runFunction: () => internal.privacyApi.privacyRun })`. A `FunctionReference` is
`{ __lunoraRef: "<file>:<function>" }` at runtime (`shared/function-reference.ts`).

**3. Register the two workflows.** The export names must match `definePrivacy({ workflows })`, which defaults to the two below. The start action resolves them with `ctx.workflows.get(name)` and fails with a named error if one is missing.

```ts
// lunora/workflows.ts
export const privacyExport = defineWorkflow({ handler: privacy.exportHandler, limits: { steps: 25_000 } });
export const privacyErasure = defineWorkflow({ handler: privacy.erasureHandler, limits: { steps: 25_000 } });
```

The config must be this literal in the app's `workflows.ts`. Codegen rejects a config imported from the
package or passed as a property (`defineWorkflow(privacy.exportWorkflow)`), so the package supplies the
handler, not the config (Phase 0 spike, §7).

**4. Declare one dataset per module, next to its tables.**

```ts
// lunora/tasks/privacy.ts
import { defineDataset } from "@lunora/privacy";

export const tasksData = defineDataset("tasks", {
    purpose: "Tasks and goals the user schedules",
    legalBasis: "contract", // Art. 6(1)(b)
    origin: "provided", // provided | observed | derived | inferred
    phase: "quiesce", // erased first: it schedules writes
    tables: {
        goals: {}, // uses .ownedBy("userId") + its index
        tasks: { omit: ["activeCycle"] }, // internal bookkeeping, not exported
        taskRuns: { origin: "observed" },
    },
});
```

**Tables without an owner column.** For a child table reached through its parent, or a shared space,
the dataset supplies `collect` and `erase` functions. These follow the §3 contracts and take `ctx`
and `{ subjectId, cursor }`. Placement is per dataset: `"subject"` (the subject's shard), `"root"`,
or `"global"`.

**Retention.** A table in a dataset whose rows must be kept uses
`erase: retain("de.voucher", { from: "issuedAt" })`.

**External effects.** Some steps act outside the database, such as cancelling a billing-provider
subscription or deleting the person at an analytics processor. These go in
`external: { beforeErase, afterErase }`. Each runs as its own deduplicated step.

**Why one central list plus colocated datasets.** The central `datasets` array is the only wiring.
Each dataset sits next to the tables it describes. A missing array entry, or a missing table inside
a dataset, is caught by the coverage check (§4.3). The package registers **three generic internal
functions** (`privacyRun` dispatches by dataset id and operation), so a module adds no new
registered functions. That also stops the hundreds of cross-module-write findings: each dataset's
handler lives in its owner module's file and runs through the package's dispatcher.

### 4.3 Coverage check: catching a forgotten table

**Rule:** every table in the merged schema must be classified exactly once, and extension tables
count. A table is classified when it is in some dataset (export plus an erase policy) or in
`exclude` with a non-empty reason. The erase policy is one of `erase`, `anonymise(fields)`,
`retain(ruleId)`, or `keep(reason)`. `keep` covers data that is personal but is not the subject's,
for example rows another user owns.

**Mechanism.** These layers are listed strongest first; ship all three over the phases.

1. **Runtime check, run by a test helper and by the dev server (Phase 1).** `checkCoverage(privacy)`
   reads `schema.tables`, including each table's `ownerField`, `softDelete` and `shardMode`. It
   returns structured problems:
    - `unclassified` (error).
    - `classified_twice` (error).
    - `owned_but_excluded` (error): the table is `.ownedBy()` but marked as not personal.
    - `no_owner_index` (error): the generic collector needs an index led by the owner field.
      Otherwise every batch scans the table.
    - `suspect_personal_field` (warning): the table is excluded, but a field is named like
      `email|userId|ip|phone|name`, or it has a relation to the auth user table.
    - `global_with_subject_placement` (error).

    `@lunora/privacy/testing` exports `expectPrivacyCoverage(privacy)` for a one-line vitest test.
    `definePrivacy` does **not** throw at load time. Taking production down for a classification gap
    would be worse than the gap, and no reliable dev-time signal was found to limit a throw to dev.
    The test helper and the Phase 3 lint are the gates. Phase 0 checks whether `lunora dev` exposes a
    dev hook worth using.

2. **Runtime verification at erasure time (Phase 2).** The step before `complete` re-counts the
   subject's rows in every table with an owner column, using the index. It also counts
   `.ownedBy()` tables that are not classified. A non-zero count blocks `completed`, sets `failed`,
   records which tables, and calls `deadlineApproaching`. This catches what the static check cannot:
   a writer racing the erasure, or a table added without a redeploy of the test.
3. **Advisor lint `privacy_table_unclassified` at ERROR level (Phase 3).** Codegen statically
   discovers `defineDataset` and `definePrivacy({ exclude })` literals. Table keys must be written
   inline, the same rule `defineModule` follows. A forgotten table then fails `lunora codegen` and
   CI. Codegen also lifts `ownerField` into `TableIR`.

**Rejected: type-level exhaustiveness.** It only works for one central map. With colocated datasets,
the union-minus-covered type gives unreadable errors and cannot see extension tables. It also has to
be repeated for JavaScript apps.

**Background writers.** `assertNotErasing(ctx, subjectId)` is exported for jobs that create subject
data. The Phase 3 lint `privacy_writer_without_erasure_guard` (WARN) flags scheduled or cron handlers
that insert into an owned table without the guard.

### 4.4 Legal criteria → code behaviour

Abbreviations: **LR** = LEGAL REVIEW required; **TR** = TAX REVIEW required. Where the text says
"verified", the wording was checked against gesetze-im-internet.de on 2026-10-11.

| #                                                                                                                    | Rule                                                                                                                                                                                                                                                                                                                                                                    | Code behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Review                                      |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| L1                                                                                                                   | **Art. 12(3)**: provide information without undue delay, at the latest within **one month** of receipt.                                                                                                                                                                                                                                                                 | `dueAt = addCalendarMonth(receivedAt)`, following Reg. (EEC, Euratom) 1182/71 Art. 3(2)(c): same date next month, or the last day of that month if the date does not exist (31 Jan → 28/29 Feb). Pure function with table tests. `receivedAt` is when the request reached the controller, not when it was verified. The EDPB Guidelines 01/2022 discuss whether the clock pauses while identity is verified; the package records `verifiedAt` but **does not pause the clock** by default.                             | LR (clock pause)                            |
| L2                                                                                                                   | **Art. 12(3) s. 2–3**: extension by **two further months** where necessary, given complexity and number of requests; the subject must be told **within the first month**, with reasons.                                                                                                                                                                                 | `privacyAdmin.extend(requestId, reason)` is allowed only while `now < dueAt` and only once. It sets `extendedDueAt = addCalendarMonths(receivedAt, 3)`, stores the reason, calls the `extensionNotice` hook, and audits the notice. With no hook configured, `extend` throws. An extension is never applied automatically.                                                                                                                                                                                             | —                                           |
| L3                                                                                                                   | **Art. 12(4)**: if the controller does not act, inform the subject within one month of the reasons and of the right to complain or seek a judicial remedy.                                                                                                                                                                                                              | Terminal state `refused`, with a required reason and a `refusalNotice` hook. Only an operator can set it. The package never auto-refuses or auto-fails; this replaces the prior art's auto-`failed` on day 30.                                                                                                                                                                                                                                                                                                         | —                                           |
| L4                                                                                                                   | **Art. 12(5)**: free of charge; for manifestly unfounded or excessive requests, a reasonable fee or refusal, with the burden of proof on the controller.                                                                                                                                                                                                                | No fee mechanism. Throttling: one open request per subject per type, and `exportCooldown` (default 0). Excessive requests are refused by an operator through L3. Throttling never auto-refuses.                                                                                                                                                                                                                                                                                                                        | LR (cooldown default)                       |
| L5                                                                                                                   | **Art. 12(6)**: where there is reasonable doubt about identity, the controller may request additional information. **Art. 32**: secure delivery.                                                                                                                                                                                                                        | Self-service requests need an authenticated `ctx.auth` subject. Erasure also needs a fresh session (`freshSessionMs`, default 24 h) and refuses impersonated sessions. Downloads need the authenticated owner and mint a short signed URL (default 15 min). Operator-created requests for people without a login record the `verificationMethod`. ID documents are never required by default (EDPB: proportionality).                                                                                                  | —                                           |
| L6                                                                                                                   | **Art. 15(1)(a–h), 15(3)**: a copy of the data, plus purposes, categories, recipients, retention period or criteria, rights, source, and automated decision-making.                                                                                                                                                                                                     | Every dataset declares `purpose`, `legalBasis`, `categories`, `recipients[]`, `retention` (a rule id or prose), `source`, and `automatedDecision`. `definePrivacy` validates them. The archive's `manifest.json` and `summary.pdf` carry them for each dataset. All origins are exported, including **derived and inferred** data, because Art. 15 covers them.                                                                                                                                                        | —                                           |
| L7                                                                                                                   | **Art. 20(1)**: data the subject **provided**, processed on **consent or contract** and **by automated means**, in a structured, commonly used, machine-readable format.                                                                                                                                                                                                | One export serves both articles. Each dataset and table entry in the manifest carries `articles: ["15"]` or `["15","20"]`. The value is computed: `20` applies when `origin ∈ {provided, observed}` (WP242 rev.01 treats observed data as "provided") and `legalBasis ∈ {consent, contract}`. A `portable/` folder holds just the Art. 20 subset as JSON. Direct transmission to another controller (Art. 20(2)) is out of scope.                                                                                      | LR (observed ⊂ provided)                    |
| L8                                                                                                                   | **Art. 15(4), 20(4)**: must not adversely affect the rights and freedoms of others.                                                                                                                                                                                                                                                                                     | For shared content, a dataset sets `thirdParty: "pseudonymise"` (the default whenever a custom collector reads rows the subject does not own). Other people's identifiers become stable per-export labels (`participant-1`). Their content is kept only where it is part of the subject's own conversation; `thirdParty: "drop"` removes it. Applied by `redactOthers(row, subjectId)`.                                                                                                                                | LR (balancing default)                      |
| L9                                                                                                                   | **Art. 17(1)**: erase without undue delay.                                                                                                                                                                                                                                                                                                                              | Accepting the request immediately restricts processing: sessions revoked, subject flagged `erasing`, `assertNotErasing` armed. Erasure starts after `erasureGrace` (decision D3; default 14 days). The grace is capped so that it ends before the Art. 12(3) deadline: `graceUntil = min(receivedAt + erasureGrace, dueAt − drainBudget)`. `drainBudget` is at least 3 days and grows                                                                                                                                  |
| with the pre-flight row count, so the erasure drain and its completion notice fall inside the month. Under the       |
| strict clock the shortest month (February) leaves 25 days after the drain budget, so at 14 days the cap never binds. |
| The capped value is stored with the request. A cancel is only accepted inside the grace window.                      | LR (grace)                                                                                                                                                                                                                                                                                                                                                              |
| L10                                                                                                                  | **Art. 17(3)(b)**: erasure does not apply where processing is needed to comply with a legal obligation.                                                                                                                                                                                                                                                                 | Policy `retain(ruleId)`. The rule names the citation, the period and the start event. Retained rows are **restricted** (L15) and get a hold row with `retainUntil`. A scheduled `runAt` erases them when the hold expires.                                                                                                                                                                                                                                                                                             | —                                           |
| L11                                                                                                                  | **Art. 17(3)(e)**: establishment, exercise or defence of legal claims.                                                                                                                                                                                                                                                                                                  | Rule `legalClaims` is **off by default**. It is opt-in per dataset and needs a concrete reason string; a blanket "we might be sued" is not a reason. The suggested period is 3 years from the end of the year, after BGB §§195, 199. Operators can also place a **case hold** on one subject (`privacyAdmin.hold`) for a known dispute.                                                                                                                                                                                | LR                                          |
| L12                                                                                                                  | **Art. 19**: notify each recipient of erasure or restriction unless that is impossible or involves disproportionate effort; tell the subject who the recipients are if asked.                                                                                                                                                                                           | Each `recipients[]` entry may carry `onErase(ctx, subject)`. The erasure workflow runs it as `privacy/v1/recipients/<dataset>/<recipient>` with a dedup id and audits the outcome. A recipient without a hook is recorded as `notified: "manual"` and is listed in the operator report. Recipients are listed in the manifest (L6).                                                                                                                                                                                    | —                                           |
| L13                                                                                                                  | **HGB §257(1), (4), (5)** (verified): books, inventories, opening balance sheets, annual and management reports **10 years**; booking vouchers **8 years** (10 for KWG, VAG and WpIG institutions); received and copies of sent commercial letters **6 years**. The period runs from the **end of the calendar year** of the last entry, receipt, dispatch or creation. | `@lunora/privacy/de` preset rules `de.books` (10y), `de.voucher` (8y, the statutory period; superseded the 2026-10-11 10-year decision, and `voucherYears: 10` keeps the old value), `de.voucher.regulated` (10y), `de.correspondence` (6y), all with `start: "endOfCalendarYear"`. `retainUntil = Dec 31 of year(from) + N years`, then erase the next day. Apps choose which tables each rule covers; the package does not guess. An invoice is a voucher; an email exchange about a contract may be correspondence. | TR                                          |
| L14                                                                                                                  | **AO §147(1), (3), (4)** (verified): the same 10 / 8 / 6-year scheme for tax purposes. Customs documents (Nr. 4a) are 10 years. "Other documents relevant for taxation" (Nr. 5) are 6 years. **Ablaufhemmung**: the period does not end while the documents still matter for a tax whose assessment period (Festsetzungsfrist) is still open.                           | Same preset rules, with `de.taxOther` (6y) added. The Ablaufhemmung **cannot be computed from app data**, so it is modelled as an operator-extended hold (`privacyAdmin.extendHold(subject, rule, until, reason)`). The rule's documentation says so. The 8-year voucher period comes from the 2024 Bureaucracy Relief Act (BEG IV); **the transition rule for vouchers whose period was still running on 1 Jan 2025 was not verified**, and neither was the matching UStG §14b invoice period.                        | TR                                          |
| L15                                                                                                                  | **Art. 18 + BDSG §35(3)** (verified): where statutory, by-law or contractual retention periods prevent erasure under Art. 17(1)(a), processing is restricted instead.                                                                                                                                                                                                   | A retained row is moved into the package-owned `privacy_archive` table (decision D4, mode `archive`). The table holds the subject key, rule, source table, payload and `retainUntil`. App code never reads `privacy_archive`, which is what makes the restriction enforceable. The original row is erased. Mode `inPlace` (the app keeps the row and promises restriction) exists for systems of record that must stay where they are. That choice is the app's, and it is documented.                                 | LR + TR (GoBD immutability vs. moving rows) |
| L16                                                                                                                  | **BDSG §35(1)** (verified): replaces erasure with restriction where erasure is impossible or disproportionate — **only for non-automated processing**.                                                                                                                                                                                                                  | **Not implemented.** Database rows are automated processing, so §35(1) does not apply to them. Shipping a "disproportionate effort → restrict" switch would invite misuse. The rule is documented as out of scope.                                                                                                                                                                                                                                                                                                     | LR (confirm)                                |
| L17                                                                                                                  | **BDSG §35(2)**: restrict instead of erase under Art. 17(1)(a) or (d) where erasure would harm the subject's legitimate interests; the subject must be told.                                                                                                                                                                                                            | Operator-only `privacyAdmin.restrictInsteadOfErase(requestId, reason)`, with a required `restrictionNotice` hook. It is never automatic.                                                                                                                                                                                                                                                                                                                                                                               | LR                                          |
| L18                                                                                                                  | **BDSG §34(1) Nr. 2, (2)** (verified): access may be refused for data kept **only** because of statutory retention, **if** providing it needs disproportionate effort **and** technical and organisational measures rule out other use. Reasons must be documented.                                                                                                     | Default: retained or archived data **is included** in the Art. 15 export, marked `restricted: true` with its rule and `retainUntil`. Including it costs nothing because the data is already indexed. The switch `omitRetainedFromAccess` exists but requires a documented reason, writes it to the audit log, and adds the justification to the manifest. The switch is off by default.                                                                                                                                | LR                                          |
| L19                                                                                                                  | **Art. 5(2), 24**: accountability. **Art. 30**: record of processing activities.                                                                                                                                                                                                                                                                                        | `privacy_events` is an append-only audit log of request lifecycle, verification, extension, holds, recipient notifications, downloads and expiry. `privacy.recordOfProcessing()` emits a **draft** Art. 30 inventory (per dataset: purpose, legal basis, categories, recipients, retention). It is an input to the controller's record, not a substitute for it.                                                                                                                                                       | —                                           |
| L20                                                                                                                  | Proof of erasure after erasure.                                                                                                                                                                                                                                                                                                                                         | After completion, request and audit rows keep only `subjectKey = HMAC(secret, subjectId)`, the request id, timestamps, per-table counts, holds and the outcome. Email and name are dropped once the confirmation hook has run. Audit retention defaults to 3 years from the end of the year (BGB §§195, 199) and is configurable.                                                                                                                                                                                      | LR                                          |
| L21                                                                                                                  | Copies outside the live tables: backups, PITR, CDC archive, logs.                                                                                                                                                                                                                                                                                                       | Built-in coverage for document history, the action cache, storage objects with an owner prefix, and request logs in `@lunora/observability`. Retention-based copies (DO PITR, at most 30 days; `lunora backup` snapshots; the R2 CDC archive) are listed in the manifest and the operator report with their expiry. A **tombstone list** (subject keys) lets a restore re-apply erasures (Phase 5).                                                                                                                    | LR (backups "beyond use")                   |

### 4.4a Where the package tables live

**Every non-`.global()` table exists on every shard.** A Durable Object shard carries the whole
schema; the runtime's export and import paths walk `shardLocalTables` per shard, and the default key
is `"__root__"` (`packages/runtime/src/create-worker.ts:91`). A write sent with a user `shardKey`
therefore lands in that shard's copy of the table. The design depends on this.

| Table              | Lives on               | Why                                                                                                                                                                                 |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacy_subjects` | the subject's shard    | Holds the `erasing` marker. `assertNotErasing` reads it inside the writer's own transaction, which closes the race.                                                                 |
| `privacy_archive`  | the source row's shard | The move happens in the same transaction as the delete; a transaction never spans shards.                                                                                           |
| `privacy_holds`    | the source row's shard | Same reason.                                                                                                                                                                        |
| `privacy_requests` | root (`__root__`)      | The operator listing, the Art. 12 timers and `privacyTick` need one index of every request.                                                                                         |
| `privacy_events`   | root                   | The audit log; it holds only the subject key after erasure (L20).                                                                                                                   |
| `privacy_index`    | root                   | One row per (subject key, shard, `retainUntil`, request) for each shard holding archive or hold rows, so the expiry sweep knows which shards to visit without scanning all of them. |

`wipeShard` and the generic eraser always exclude `privacy_*`.

**`.global()` sources.** No transaction can span D1 and a Durable Object. For these, the step copies
rows into the archive under deterministic archive ids (`<sourceTable>:<rowId>`), so a retry
overwrites instead of duplicating. A second step then deletes the source rows. A crash between the
two steps leaves a duplicate copy, never a lost record.

### 4.5 Request lifecycle

```text
received ──verify──► accepted ──start──► processing ──► ready ──(expiresAt)──► expired     (export)
    │                    │                    │      └──► completed                        (erasure)
    │                    │ (erasure: grace)   ├──► failed  (retryable by operator; the clock keeps running)
    │                    └──cancel──► cancelled  (export: any time before ready; erasure: only in grace)
    └──operator──► refused (Art. 12(4) notice)
Orthogonal: extendedDueAt (L2), overdue = now > (extendedDueAt ?? dueAt) && !terminal.
```

**Timers.** Every request gets `runAt` timers at `dueAt − 7d` (`deadlineApproaching`), at `dueAt`
(overdue escalation and audit), and for exports at `expiresAt` (delete the file). Timers run on all
three hosts. A daily cron calls `privacyTick` as a backstop where crons exist; it re-arms lost timers
and restarts requests stuck in `received` or `accepted`. Restarting stuck requests is the outbox
recovery the prior art lacked.

**Starting the workflow.** The request mutation inserts the row and schedules
`runAfter(0, privacyRun.start)`. The start action calls `create({ id: requestId })`. A duplicate is a
no-op, so a redelivered start is safe.

### 4.6 Export workflow (`privacyExport`)

**Implemented file layout.** Each export run takes a run id from a
journaled step and writes its files under `<requestId>/<runId>/`: `parts/<dataset>.json`,
`export.zip` and `summary.pdf`. A run that loses the ready claim deletes only its own files, so
two runs of one export never touch each other's archive. **Upgrade:** an export in flight across
this change fails at its assemble step, because its journaled collect steps were recorded under the
old flat names. An operator retries it. This is accepted as a documented breaking change on `alpha`;
no read fallback for the old names.

**Steps:**

1. `privacy/v1/export/begin`: mark the request `processing`.
2. For each dataset, then table, then page: `privacy/v1/export/collect/<dataset>/<table>/<n>`.
    - The step runs the collector on the dataset's placement shard.
    - It applies `omit` and third-party redaction.
    - It writes the dataset's part to `<requestId>/<runId>/parts/<dataset>.json`, in the wire codec.
    - It returns `{ key, count, sha256, cursor }`.

    Page size defaults to 500 rows and adapts down if a page exceeds 4 MiB. The step name is
    deterministic because each cursor is memoised. A guard throws `PRIVACY_EXPORT_TOO_LARGE` before
    reaching the step limit.

3. `privacy/v1/export/files/<dataset>`: copy the subject's storage objects that a dataset declares
   (`files: { prefix | list }`) into the archive.
4. `privacy/v1/export/assemble`: stream a ZIP from the parts into a multipart upload at
   `<requestId>/<runId>/export.zip`, and the summary at `<requestId>/<runId>/summary.pdf`.
    - The ZIP uses **DEFLATE** compression (decided 2026-10-11, overriding the earlier STORE choice
      that kept CPU cost lowest). Compression is the main CPU cost of this step. **Phase 0 check:** measure
      the DEFLATE cost on a heavy export (the largest dataset the app allows) against the Workers CPU
      limit, and fix the compression level from that measurement. If it does not fit, the fallback is
      to compress per part at write time instead of in one pass.
    - The stream goes through the equal 5 MiB part coalescer that `@lunora/storage/upload` already
      uses.
    - A retry aborts any stale upload id and overwrites the key.
    - **Phase 0 check:** `fflate` `ZipDeflate` is verified on workerd (not `AsyncZipDeflate`, which fails there). It writes `manifest.json` and `summary.pdf`, a human-readable Art. 15 copy in the
      subject's locale, defaulting to English and German. **Phase 0 check:** a PDF library must run
      on Workers (pure JS, no native code) and must produce identical bytes for an identical export.
5. `privacy/v1/export/finalize`: set `ready` and `expiresAt` (default 7 days) and arm the expiry
   `runAt`. The parts stay until expiry, which deletes every file under `<requestId>/`.
6. `privacy/v1/export/notify`: run the `exportReady` hook with a dedup id.
7. `privacy/v1/export/audit`.

**Format.** ZIP containing:

- `manifest.json`: format version, subject key, generation time, and per-dataset
  `{ articles, origin, legalBasis, purpose, recipients, retention, restricted, files[] }`.
- `data/<dataset>/<table>.json`, written as JSON arrays. NDJSON is used only internally.
- `portable/`, the Art. 20 subset.
- `files/`.
- `summary.pdf`: the human-readable Art. 15 copy, with the same dataset descriptions as the manifest.

JSON is the machine-readable format for Art. 20: structured, commonly used and machine-readable.
The PDF is the readable copy for the subject. Neither replaces the other. CSV was rejected because nested
documents flatten badly. The download is never emailed. The hook receives a link to the app's
privacy page, which calls `exportDownloadUrl` and gets a 15-minute signed URL. Each download is
audited.

**Consistency.** Collection spans many transactions, so the export is not a point-in-time snapshot.
The manifest states this, and each part records its own `collectedAt`.

### 4.7 Erasure workflow (`privacyErasure`)

**Phases.** Datasets declare `phase`, and order within a phase follows the `datasets` array:

1. `privacy/v1/erase/begin`: record the subject email for the confirmation, set `erasing`, and
   revoke sessions through the auth contribution.
2. `privacy/v1/erase/grace`: `step.sleepUntil(graceUntil)`, then re-read the status. If cancelled,
   stop and audit.
3. `quiesce`: datasets that create data, such as schedules, tasks or agents. Their `erase` drains
   first.
4. `external/<dataset>`: `beforeErase` hooks that need data before it is deleted (tokens to revoke a
   grant, billing cancellation).
5. `content`: the default phase. The drain for `<dataset>` runs as
   `privacy/v1/erase/<dataset>/<n>`. Each step loops batches up to a CPU budget (default 20 s of the
   30 s per-step limit), then returns `{ hasMore }`, and the next step continues. Retained tables are
   archived and their holds written in the same transaction as each batch's delete.
6. `identity`: auth records, through `authDataset` (`removeUser`).
7. `residual`: document history, the action cache, and `.softDelete()` leftovers, all hard-deleted.
   This phase runs last because every earlier audited delete wrote a snapshot.
8. `privacy/v1/recipients/<dataset>/<recipient>` (L12).
9. `privacy/v1/erase/verify` (§4.3 layer 2).
10. `privacy/v1/erase/complete`: set `completed`, run the `erasureCompleted` hook with the captured
    email, then drop the email (L20).

**Crashes and redelivery.**

- Each step is memoised.
- Every mutation is run through `ctx.runStep` or with `dedupId: <requestId>:<step>`.
- Every batch is idempotent.
- The workflow id is the request id.
- The `verify` step makes a partly applied erasure visible instead of silent.
- A stuck instance (errored after retries) leaves the request `failed` and the operator is alerted.
  `privacyAdmin.retry` starts a new instance id `<requestId>:r<n>`. That is safe because every step is
  idempotent.

**Holds stay consistent with erasure.** A table under `retain` is never deleted by the generic
eraser. Its rows move to `privacy_archive` in the same transaction as each batch. `retainUntil` is
recomputed from the row's `from` field, using the latest date when a row matches more than one rule.
A hold only ever extends (`extendHold`) and is never shortened. The expiry eraser re-checks that the
hold is unexpired and that no case hold exists, so it cannot delete early.

## 5. Workstreams

| WS  | Size | Work                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | S    | Scaffold `packages/privacy` with `vis generate lunora-package --name=privacy`. Add ROADMAP experimental list, api-snapshot `TIER_3`, `.releaserc.json`, `project.json` (`category:add-on`). Register `PRIVACY_COVERAGE`, `PRIVACY_EXPORT_TOO_LARGE`, `PRIVACY_REQUEST_OPEN` and `PRIVACY_SESSION_NOT_FRESH` in `@lunora/errors` `ERROR_CATALOG`. Add a row to `.agents/docs/packages.md` and update the package counts in AGENTS.md. |
| B   | M    | Core, pure and host-free: rule engine (`addCalendarMonth`, `retainUntil`), classification, `checkCoverage`, Art. 15/20 tagging, `redactOthers`, manifest builder.                                                                                                                                                                                                                                                                    |
| C   | M    | Component: `privacyExtension` tables (`requests`, `events`, `holds`, `archive`, `tombstones`), lifecycle mutations, timers, `privacyAdmin`.                                                                                                                                                                                                                                                                                          |
| D   | M    | Export workflow handler, parts, ZIP assembly, signed download.                                                                                                                                                                                                                                                                                                                                                                       |
| E   | L    | Erasure workflow handler, generic owner-column eraser, archive and holds, verify, recipients.                                                                                                                                                                                                                                                                                                                                        |
| F   | S    | Presets: `/eu` (L1–L12, L18–L20) and `/de` (L13–L17), each rule with citation, period, start and `reviewRequired` metadata.                                                                                                                                                                                                                                                                                                          |
| G   | S    | Built-in datasets: `authDataset`, `documentHistoryDataset`, `actionCacheDataset`, `storageObjectsDataset`.                                                                                                                                                                                                                                                                                                                           |
| H   | M    | Codegen: `ownerField` into `TableIR`; discover `defineDataset` and `definePrivacy` literals; advisor lints `privacy_table_unclassified` (ERROR) and `privacy_writer_without_erasure_guard` (WARN).                                                                                                                                                                                                                                   |
| I   | S    | Docs page (`apps/docs`), plus a generic "replace a hand-built module" migration section with a step-name compatibility mode for in-flight instances.                                                                                                                                                                                                                                                                                 |
| J   | M    | Phase 5: restore re-erasure from tombstones; a Studio "Privacy requests" page.                                                                                                                                                                                                                                                                                                                                                       |

**Package layout:**

- `src/index.ts`: `definePrivacy`, `defineDataset`, `retain`, `anonymise`, `keep`,
  `privacyExtension`, built-in datasets, types.
- `src/eu.ts`, `src/de.ts`: the presets.
- `src/testing.ts`: `expectPrivacyCoverage` and an in-memory workflow double for crash tests.
- `src/internal/*`: not exported.
- Exports: `.`, `./eu`, `./de`, `./testing`. Named exports only; no `.js` extensions.

**Dependencies:**

- `@lunora/server`, `@lunora/values`, `@lunora/errors` and `@lunora/workflow` at exact workspace
  versions, the same form `@lunora/agent` uses.
- `fflate` (zero dependencies, pure JS, synchronous `ZipDeflate` entries, verified on workerd) under
  a new `catalog:privacy` entry, never a bare version. `client-zip` was rejected: it does not
  compress, and its README targets browsers.
- `@lunora/auth` is an optional peer used only by `authDataset`. It gets a real semver range, not
  `catalog:` (see the catalog-in-peerDependencies trap).

Run `pnpm run lint:package-json` after scaffolding.

## 6. Platform parity

**This plan adds no `ctx.*` surface and no binding.** The package ships functions and workflows
through `defineComponent`, so `PlatformCapabilities` gains no row. If a later phase adds `ctx.privacy`,
that phase must add the row. The table below records what the package depends on, so a host gap is
known up front:

| Dependency                    | `cloudflare` | `node`      | `celld`          | Notes                                                                                                                                     |
| ----------------------------- | ------------ | ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows`                   | native       | emulated    | native (caveats) | celld replays non-step code. The handler keeps all side effects inside steps, and step results stay ≤ 1 MiB by design (parts in storage). |
| `workflowSchedules`           | native       | unsupported | unsupported      | **Not used.** Deadlines use per-request `runAt`.                                                                                          |
| `objectStorage` (+ multipart) | native       | emulated    | emulated         | celld multipart cannot resume across nodes. `assemble` restarts from the parts on retry, which is correct but slower.                     |
| signed URL (`getSignedUrl`)   | native       | emulated    | emulated         | Lunora-signed and host-neutral. **Phase 0: verify the node fs bucket serves it.**                                                         |
| `scheduler` (`runAt`)         | emulated     | emulated    | emulated         | Carries every Art. 12 timer.                                                                                                              |
| `cronTriggers`                | native       | unsupported | native           | Backstop only. On node the app calls `privacyTick` from its own loop; the docs say so.                                                    |
| `mail`                        | native       | unsupported | emulated         | **Not a dependency.** Hooks only.                                                                                                         |
| auth store (`removeUser`)     | native       | emulated    | native           | Through `@lunora/auth`'s adapters. Hosts without auth supply their own `identity` dataset.                                                |

## 7. Phasing & ordering

| Phase | Work                                                                                                                                                                   | Gate                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Decisions D1–D6. Codegen spike: `defineWorkflow({ handler: privacy.exportHandler })` registers. Node signed-URL check. Legal and tax review of §4.4 rows marked LR/TR. | Met for the codegen part: `packages/codegen/__tests__/privacy-handler.test.ts` covers the accepted and rejected shapes (§7 Phase 0 results). Still open: the Workers, PDF and signed-URL checks; written answers to §9 (legal and tax review). |
| 1     | WS A + B + C + D + G (auth, storage), plus `expectPrivacyCoverage`. **First shippable slice: export only.** It is read-only, so it is safe to dogfood.                 | Unit suites for L1–L8, L18; the coverage test; the export crash test (§8); `api:check` after `build:packages`; `lint:package-json`; a playground app exports and the archive validates against the manifest JSON Schema.                       |
| 2     | WS E + F + G (rest): erasure, holds, archive, presets.                                                                                                                 | Erasure crash matrix (§8); the workerd suite; the verify step fails a seeded race; dogfood on an app with a hand-built module under a compatibility mode.                                                                                      |
| 3     | WS H: codegen and advisor lints.                                                                                                                                       | Lint fixture: an unclassified table fails `lunora codegen`; a sabotage check deletes one dataset entry and the lint fires.                                                                                                                     |
| 4     | WS I: docs and migration guide.                                                                                                                                        | Docs build; the link check runs after content generation.                                                                                                                                                                                      |
| 5     | WS J: restore re-erasure and the Studio page.                                                                                                                          | A restore test re-erases a tombstoned subject.                                                                                                                                                                                                 |

**Phase 0 results (2026-10-11).**

- **Codegen spike: run through `runCodegen` on a copy of the simple fixture. The STOP condition does
  not fire.** Results by shape (committed as `privacy-handler.test.ts`):
    - Handler from an app file, `defineWorkflow({ handler: privacy.exportHandler, name })`: accepted, and
      `_generated/workflows.ts` is emitted.
    - Handler from a package, reached through an app object (`privacy.exportHandler`): accepted, and emitted.
    - Config imported from a package, `defineWorkflow(exportWorkflow)`: **rejected** with a located
      diagnostic, because the argument must be an object literal or a local `const` holding one.
    - App config property, `defineWorkflow(privacy.exportWorkflow)`: **rejected** the same way.

    So the app writes the `defineWorkflow({...})` literal itself, and the package supplies only the handler
    (§4.2 step 3). Two findings to design around:
    1. **Steps are invisible.** A package-declared handler lifts with `steps: []`, so the duplicate-step-name
       lint cannot see the package's `ctx.step.do` names. The package must test its own step names.
    2. **A stray `handlerFile`.** For a function declaration in a `.d.ts`, discovery writes
       `handlerFile` as a relative path into `node_modules/<pkg>/index.d`. Nothing reads it today, but
       it is wrong. A codegen follow-up should label such a handler by its package name instead.

- **ZIP library: checked on Node and workerd.** `ZipDeflate` (synchronous) writes a valid DEFLATE ZIP
  on workerd: a 1.2 MB JSON sample became 51,935 bytes in 42 ms wall time (`@cloudflare/vitest-plugin`
  1.4.0, workerd via wrangler 4.149.0, same versions as the repo's catalog). The same bytes came from Node.
  **`AsyncZipDeflate` fails on workerd** with `Worker is not defined`, so the plan uses `ZipDeflate` only.
  Wall time is not CPU time, and the sample is not the largest allowed export; see Phase 1.
- **PDF library: decided, `@cantoo/pdf-lib` 2.11.1 (MIT), a maintained fork of `pdf-lib` with the same API.** The Phase 0 measurements below were taken on `pdf-lib` 1.17.1 (last published 2022-05-12, so it was replaced); they have not been repeated on the fork. On workerd it rendered 40 pages (49 KB) in 98 ms, and two runs with a fixed creation date were byte-identical. A 200-page render of the large export took about 1.6 s. Its dependencies are pure JS. It was last published 2022-05-12, so the maintenance risk is accepted and re-checked at each release. `pdfkit` (Node-oriented) and `jspdf` (browser-first) were rejected.
- **Node signed-URL check: passed.** The storage package's `signed-url.test.ts` passes 30 of 30 cases,
  covering expired URLs, tampered keys, wrong secrets, and malformed input.
- **DEFLATE CPU measurement: done for a 40 MB export, on workerd.** A 39.5 MB JSON export compressed with `ZipDeflate` at level 6 in about 2.6 s of wall time (0.90 MB out, for a sample that compresses well), and the 200-page PDF took about 1.6 s. Wall time is not CPU time, and real data compresses less, so the cost may be higher. Even so, this is well inside the 30 s default CPU limit. **Proposed cap:** the pre-flight refuses exports above 200 MB (`PRIVACY_EXPORT_TOO_LARGE`). That figure is a recommendation for the maintainer to confirm, and the measurement above is the evidence behind it.

- The legal and tax review (§10) is the user's to complete. Phase 0 cannot close until it is.

**Test strategy:**

- **Criteria unit tests** (node project), table-driven:
    - `addCalendarMonth`: 31 Jan → 28/29 Feb, 30 Apr → 30 May, year rollover, DST boundaries with UTC
      storage.
    - `extend` is refused after `dueAt` and refused twice.
    - `retainUntil`: end of calendar year plus N, and the most restrictive of overlapping rules.
    - Art. 20 tagging across origin and legal basis.
    - `redactOthers` produces stable pseudonyms.
    - The §34 omission switch requires a reason.
- **Coverage test.** Fixture schemas with an unclassified table, an `.ownedBy` table that is
  excluded, a missing owner index, and an extension table. Each test is checked by **breaking the
  code**: remove the check, and the test must fail.
- **Durable crash tests.** An in-memory workflow double throws after each step N in turn and replays.
  The final state must equal an uninterrupted run:
    - Same archive bytes (sha256) for the same compression level and library version. ZIP entry mtimes and `manifest.generatedAt` come from the
      memoised `begin` step result, so a replay produces the same bytes.
    - For a crash between steps, exactly one `exportReady` hook call. For a crash inside the notify
      step, every call carries the same `idempotencyKey`.
    - Exactly one audit row per event; assert the count, not just presence.
    - Zero residual subject rows.
    - Holds written once.
- **Scale test.** 2,500 rows per owner across 3 tables, checked against the unfixed generic eraser
  first, to prove batching and the 100-bound-parameter ceiling.
- **Workerd project** (`LUNORA_WORKERD_TESTS=1`). Required because the package touches SQL and
  Durable Objects:
    - Generic eraser on DO SQLite with triggers (`TRIGGER_DEPTH` 10).
    - `.softDelete()` hard delete.
    - Archive move atomic with delete.
    - `deleteAll` on a cascade.
    - Owner-index reads.

    Add `privacy` to the `test-workerd` matrix in **both** `.github/workflows/test.yml` and
    `nightly.yml`; the count assertion fails otherwise. Run `pnpm run test:workerd` before every push
    that touches C or E.

## 8. Risks & STOP conditions

- **STOP** if the Phase 0 spike shows codegen rejects an imported `handler`. Then the workflows need
  codegen auto-registration, as `@lunora/agent` has (`discover/agents.ts`). That is a cross-package
  change; re-plan WS D/E instead of working around it.
- **STOP** if legal review rejects L15 archive mode for accounting records (GoBD immutability and
  machine-readability). In that case `inPlace` becomes the only mode for `de.books`/`de.voucher`, and
  the restriction guarantee moves to an RLS policy the package generates. That is a redesign.
- **Risk:** apps classify a table as excluded to silence the check. Mitigate:
  `owned_but_excluded` and `suspect_personal_field` cannot be suppressed without a reason, and
  reasons are listed in the Art. 30 draft, where a reviewer reads them.
- **Risk:** the Workers Free plan allows 10 ms CPU and 1,024 steps per workflow, which cannot run the 20 s drain budget or `limits: { steps: 25_000 }`. Mitigate: the package states that it requires Workers Paid on Cloudflare. It cannot detect the plan, so the docs say this, and the workflow example sets the limits explicitly.
- **Risk:** a long erasure crosses the 25,000-step or 1 GB-per-instance limit. Mitigate: CPU-budgeted
  drains (few steps), parts outside step state, and a pre-flight row count that refuses with
  `PRIVACY_EXPORT_TOO_LARGE` and pages the operator instead of failing midway.
- **Risk:** a background writer recreates rows after their table was drained. Mitigate: the `quiesce`
  phase, `assertNotErasing`, the WARN lint, and the verify step (which fails rather than completes).
- **Risk:** placement mistakes, such as a dataset on the wrong shard or a `.global()` table under
  subject placement. Mitigate: the coverage problem `global_with_subject_placement`, and verify
  counting on the declared placement.
- **Risk:** legal defaults age; BEG IV just changed voucher periods. Mitigate: each rule carries
  `citation`, `verifiedAt` and `reviewRequired`. Changing a default is a `feat` with the legal change
  in the commit body, and existing holds keep the `retainUntil` they were computed with.
- **Perf watch:** no `__bench__` suite exists for this. Add `packages/privacy/__bench__/erase.bench.ts`
  (generic eraser, 10k rows over 5 tables, DO SQLite through the workerd harness).

## 9. Open questions: maintainer decisions (each with a recommendation)

1. **D1 Name. Decided: `@lunora/privacy`**, with presets at `/eu` and `/de`.
2. **D2 German retention defaults. Superseded: voucher retention is the statutory 8 years**, the default of `germany()`.
   `voucherYears: 10` keeps the 10-year value of the 2026-10-11 decision (the PR #85 value). Recommendation kept below for
   the other rules. Recommend shipping the statutory values as **named rules with no
   table bindings**: 10y books, vouchers at 8y, the statutory period (regulated institutions 10y), 6y correspondence and other tax
   documents, all from the end of the calendar year. The app binds tables explicitly. Never infer
   which table is a voucher. Ablaufhemmung is an operator hold extension. Legal claims (3y) is
   opt-in. Pending TR/LR.
3. **D3 Hard delete or anonymise, and grace.** Recommend **hard delete** as the generic default.
   Anonymisation is per table and allowed only where the remaining row cannot be linked back to the
   person, for example aggregate counters or ledger rows that keep a `deleted-user` marker.
   **Decided (2026-10-11): grace window 14 days**, below the 30-day organisation window in PR #85.
   LR must still confirm it against "without undue delay" before it ships. Processing is restricted
   during the window. The window is capped before the Art. 12(3) deadline, with a drain budget (L9).
   The effective grace is 14 days.
4. **D4 Retained data: archive or in place. Decided: `archive`** (a package-owned table, so
   restriction is enforceable), with `inPlace` per rule for systems of record. Pending LR + TR on
   GoBD.
5. **D5 Export format. Decided (2026-10-11): JSON and PDF.** A compressed (DEFLATE) ZIP holding the JSON data, plus
   `manifest.json`, the `portable/` Art. 20 subset and a `summary.pdf` readable copy (replacing the
   earlier `README.html`). The PDF library is `@cantoo/pdf-lib` (a maintained fork of `pdf-lib`). The package and workerd suites pass on it; the Phase 0 timing and byte-identity checks were run on `pdf-lib` 1.17.1 and need repeating. Files expire after 7 days, and download links are 15-minute signed URLs behind
   authentication.
6. **D6 Does the identity-verification time pause the one-month clock? Decided: no** (strict clock)
   until legal review says otherwise.

## 10. Items needing legal (LR) or tax (TR) review

1. **Art. 12(3) clock.** Is the month computed under Reg. 1182/71, as assumed? Does the clock pause
   during identity verification (L1, D6)?
2. **Art. 20 scope.** Should observed data count as "provided" (L7)? Is pseudonymising third parties,
   rather than dropping them, the right Art. 15(4)/20(4) balance (L8)?
3. **Erasure grace.** Is a 14-day grace window, with processing restricted and capped before `dueAt` with a drain budget,
   compatible with "without undue delay" (L9)?
4. **Legal-claims hold.** Is 3 years from the end of the year appropriate (L11)? Same question for
   audit retention after erasure (L20).
5. **HGB §257 / AO §147 mapping (TR).** Which app records are vouchers, which are correspondence, and
   which are other tax documents? What is the BEG IV transition rule for vouchers already being
   retained on 1 Jan 2025? Was the UStG §14b invoice period changed as well? How should the AO
   Ablaufhemmung be handled in practice (L13, L14)?
6. **GoBD.** Is moving retained records into an archive table compatible with GoBD immutability and
   machine-readability requirements (L15, D4)?
7. **BDSG §35.** Confirm that §35(1) does not apply to automated processing (L16). Define the
   operator procedure for §35(2) (L17).
8. **BDSG §34.** Is the §34(1) Nr. 2 omission switch ever appropriate for a SaaS app, and what must
   the documented reasons contain (L18)? The compatibility of §§34 and 35 BDSG with the GDPR
   opening clause (Art. 23) is debated, so get an opinion on relying on them at all.
9. **Backups.** Is it acceptable to let backups and PITR keep erased data until their rotation (at
   most 30 days for PITR), with re-erasure on restore, and what must the privacy policy say about it
   (L21)?
10. **Grace and the one-month clock.** The grace ends before `dueAt` (L9). Does the cancellable
    window count as part of the request for Art. 12(3)? If the window is capped so the erasure and
    its notice land inside the month, does the subject still get erasure "without undue delay"? A
    request is never shortened: at 14 days the cap never binds. Confirm that the cap is still needed.
