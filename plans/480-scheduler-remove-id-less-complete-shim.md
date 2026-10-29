# Plan 480 — Require the job id on `/complete` so a completion frees its own slot

**Baseline:** `dcffa4d73` (2026-10-11)
**Status:** TODO

**Priority:** P2 · **Effort:** S–M · **Risk:** medium (the admin pool-release route sends the id-less form on purpose) · **Depends on:** none · **Category:** bug (breaking on pre-release)

## 0. Headline finding

`POST /complete` without a job `id` releases a slot by dropping the LAST id in `pool.inFlightIds`, not
the job that finished. While that other job is still running, its slot is freed, so the pool can run
one job more than `maxConcurrency`. The only in-repo caller that sends the id-less form is the operator
recovery route `POST /_lunora/admin/scheduled/pool/release`, so "require the id" is not a one-line change:
the recovery path has to be redesigned in the same PR.

## 1. Current state (audit at dcffa4d73)

- `packages/scheduler/src/scheduler-do.ts:1451-1454` — `handleComplete` reads `id` as optional:
  `const jobId = typeof body?.id === "string" && body.id.length > 0 ? body.id : undefined;`
- `scheduler-do.ts:1471` — `jobId === undefined ? SchedulerDO.releaseFirstSlot(pool) : SchedulerDO.releaseSlot(pool, jobId)`.
- `scheduler-do.ts:425-433` — `releaseFirstSlot` does `pool.inFlightIds.slice(0, length - 1)`. The name says
  "first"; the code drops the last-inserted id. Its own doc (`scheduler-do.ts:419-422`) calls it a "legacy
  `/complete` payload" shim, yet the admin route sends it on purpose.
- `scheduler-do.ts:407-415` — `releaseSlot` filters by id and is idempotent. This is the correct path.
- **Concrete failure.** `maxConcurrency: 2`, jobs A and B dispatched, `inFlightIds = [A, B]`. An id-less
  complete (from the admin route) removes B, so `inFlightIds = [A]`. A finishes and its id-based complete
  empties the set, `inFlight = 0`, while B is still running. A third job is dispatched, so 2 jobs run
  against a cap of 2 with B untracked; the overshoot is one per id-less release.
- `packages/runtime/src/create-worker.ts:3512-3526` (`releasePoolSlot`) returns early unless `candidate.id`
  is a string, then sends `{ id, pool }`. The runtime dispatch path never sends the id-less form.
- `packages/runtime/src/scheduled-admin-routes.ts:126-151` (`handlePoolRelease`): `id` is optional on
  purpose (`:138`, `:142`). Its doc (`:107-125`) says it is "the ONLY shipped way to undo a leaked slot"
  because `/status` reports counts, not ids. An operator cannot name the job holding the slot.
- Tests: every `/complete` POST in `packages/scheduler/__tests__/workpool.test.ts` and
  `scheduler-do.lease.test.ts` sends an `id`. No scheduler test covers the id-less branch. The runtime
  admin test (`packages/runtime/__tests__/scheduled-admin.test.ts:473-494`) asserts the id-less forward
  only for the id-bearing case.
- `plans/README.md` has no row for 480 on this branch, so the wording above comes from the finding text.

## 2. Existing seams (do not reinvent)

- `SchedulerDO.releaseSlot(pool, jobId)` (`scheduler-do.ts:407`) is the id-based release. Use it only.
- `inFlightIds` is written at reservation (`scheduler-do.ts:1150-1156`) and preserved by `persistPoolCap`
  (`:1569`). The id set is the source of truth; no new storage key is needed.
- `DO /status` (`handleStatus`) already reads `pool:<name>`. Reporting `inFlightIds` there gives the
  operator the id to release.
- `SchedulerHost` (`packages/scheduler/src/scheduler-host.ts`) does not mention `/complete`. The HTTP
  contract lives on the SchedulerDO and is called by `packages/runtime`.

## 3. The behavioural contract to preserve

- `POST /complete { id, pool }` releases exactly the slot held by `id`, and a duplicate is a no-op
  (`workpool.test.ts:176-200`).
- A completion that lands during a dispatch await does not resurrect a slot
  (`workpool.test.ts:204`).
- Legacy pool rows with no `inFlightIds` still decrement with a clamp at zero (`releaseSlot`,
  `scheduler-do.ts:408-410`).
- Runtime dispatch sends `{ id, pool }` (`create-worker.ts:3524`) and is unchanged.

## 4. Design decisions

- **D1 (chosen): `/complete` requires `id` when `pool` is set.** Missing `id` returns `400 INVALID_INPUT`.
  Alternative rejected: keep the id-less branch but rename it. That keeps the oversubscribing path and
  only hides it.
- **D2 (chosen): the admin route requires `id`, and `/status` exposes `inFlightIds` per pool.** The
  operator reads the id from `/status`, then releases it. Alternative rejected: a separate
  `/pool/release-any` DO route for a blind drop. It adds a second release path, and the drop is what
  causes the overshoot.
- **D3 (open, see §9.1): legacy rows with no `inFlightIds`.** They cannot name an id. Keep the clamped
  decrement for them only, and document that they can be recovered only by the id-based path after a
  restart writes the set.

## 5. Workstreams

1. **Failing test first (S).** In `packages/scheduler/__tests__/workpool.test.ts`, add a case: two jobs in
   flight, `POST /complete` with `{ pool: "p" }` and no id, then assert the response is 400 and both
   ids remain in `inFlightIds`. On `dcffa4d73` it returns 200 and drops one id. Keep it failing until
   step 2.
2. **Reject id-less completion in the DO (S).** In `handleComplete` (`scheduler-do.ts:1451-1472`), return
   `SchedulerDO.error(400, "INVALID_INPUT", "id is required")` when `jobId` is undefined. Delete
   `releaseFirstSlot` (`:425-433`) and its doc. Keep the `pool` check first.
3. **Expose held ids on `/status` (S).** Add `inFlightIds` to the per-pool block of `handleStatus`.
   Tests: `scheduler-do.lease.test.ts` status assertions.
4. **Admin route requires id (S).** In `scheduled-admin-routes.ts:126-151`, return
   `BAD_REQUEST` 400 when `id` is missing. Update the doc at `:107-125` to say the operator reads the id
   from `/status`. Update `scheduled-admin.test.ts` for the 400.
5. **Runtime dispatch unchanged.** Confirm `create-worker.ts:3512-3526` still always sends `id`. Do not
   edit it.

## 6. Platform parity

Not applicable to `PlatformCapabilities`: no `ctx.*` surface, binding or deploy capability is added. The
change is to the SchedulerDO HTTP contract (`POST /complete`, `GET /status`) between `packages/scheduler`
and `packages/runtime`. `SchedulerHost` is unchanged. Any other host that implements `/complete` must
require `id` too. State this in the commit body.

## 7. Phasing & ordering

1 (red test) → 2 (DO) → 3 (status) → 4 (admin route) → full scheduler and runtime suites. One commit.

| Phase | Work                      | Gate                                                                                                       |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0     | Red test in workpool.test | `pnpm --filter "@lunora/scheduler" run test` fails on the new case, passes on nothing else                 |
| 1     | DO rejects id-less        | Red test green; `scheduler-do.lease.test.ts` green                                                         |
| 2     | Status exposes ids        | New status assertion green                                                                                 |
| 3     | Admin route requires id   | `pnpm --filter "@lunora/runtime" run test` green, `scheduled-admin.test.ts` updated, no assertion weakened |
| 4     | Workerd SQL path          | `pnpm run test:workerd` green (the scheduler DO is touched)                                                |

## 8. Risks & STOP conditions

- **STOP** if production pools still hold rows without `inFlightIds` and an operator needs the id-less
  recovery. Then D3 must be decided first; do not delete the admin route's blind drop.
- **STOP** if any runtime outside this repo (a template, a `sdks/*` client, or `apps/*`) sends `/complete`
  without an id. Grep found none; re-check `sdks/` and `templates/` before the commit.
- **Risk:** the recovery path becomes harder to use, because `/status` now has to be read first.
  Mitigate: the admin route response includes the id it released.
- **Perf watch:** none expected. `releaseSlot` is O(n) on a set of at most `maxConcurrency` ids.

## 9. Open questions

1. Does any production pool row lack `inFlightIds`? Check with a read-only `/status` before step 2.
2. Should `/status` return the ids to every caller, or only behind the admin token? The admin route is
   the only caller today, so the answer is the admin token.

## Commands

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
pnpm run build:packages
pnpm --filter "@lunora/scheduler" run test --no-cache
pnpm --filter "@lunora/runtime" run test --no-cache
pnpm run test:workerd
pnpm run api:check
pnpm run lint:eslint
pnpm run lint:types
```

## Scope

**In:** `packages/scheduler/src/scheduler-do.ts` (`handleComplete`, `releaseFirstSlot`, `handleStatus`),
`packages/runtime/src/scheduled-admin-routes.ts` (`handlePoolRelease`), and their tests.

**Out:** `create-worker.ts` runtime dispatch, `SchedulerHost`, `create-workpool.ts` public API, cron,
delay validation, any other scheduler file.

## Git workflow

- Branch: `advisor/480-scheduler-complete-id` from `alpha`.
- One commit, `fix(scheduler): require the job id on pool /complete`, body wrapped at 100 columns.
  The body must say this is a breaking change for id-less callers and that alpha is pre-release, so
  semantic-release records it. Do not name any external project.
- Do not push. Do not run `git add -A`; stage the explicit paths only.

## Test plan

- Red test: two in flight, id-less complete returns 400 and keeps both ids.
- Existing duplicate-complete and resurrection tests stay green with no assertion edited.
- Admin route: missing id returns 400; id-bearing forward unchanged.
- Status: `inFlightIds` present for pooled rows, absent for non-pooled.
- Workerd project green for the DO change.

## Done criteria

- Red test added first and shown failing on `dcffa4d73`, then green.
- `releaseFirstSlot` deleted; no id-less branch remains in `handleComplete`.
- Admin route and its doc updated; `scheduled-admin.test.ts` passes.
- `pnpm run api:check` shows no diff, or any diff is explained in the commit body.
- Commit on `advisor/480-scheduler-complete-id`, not pushed.

## Note on the title

The finding's title says "so a completion frees its own slot". The audit shows the defect is the
opposite: the id-less path frees another job's slot. The admin route is the in-repo caller of the
id-less form, which the title did not mention.
