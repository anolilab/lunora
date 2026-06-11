# Plan 004: Integration-test the mutation → subscription-refresh pipeline inside ShardDO

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 999c9e1..HEAD -- packages/do/src/shard-do.ts packages/do/__tests__/`
> If `refreshSubscriptions` in `shard-do.ts` no longer matches the excerpt in
> "Current state", STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (test-only changes; risk is sunk effort if the harness can't reach the seam — see STOP conditions)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `999c9e1`, 2026-06-11

## Why this matters

The reactive core of the framework — a mutation writes rows, changed tables
are computed, and live subscriptions whose queries read those tables re-run
and push fresh data over WebSockets — is covered at the unit level
(reactive cache, ctx-db) and at the slow E2E level (`tests/e2e`), but no
mid-level test exercises the pipeline *through ShardDO itself*: changed-tables
→ memo check → `executeSubscription` re-run → `pushSubscriptionData`, including
the memo-based skip for unaffected subscriptions. A protocol or
dependency-tracking regression here currently survives unit tests and is only
caught by E2E (slow, not run per-package). This is also the safety
prerequisite for any future refactor of the 3.5k-line `shard-do.ts`.

## Current state

- `packages/do/src/shard-do.ts` (3499 lines) — the Durable Object. The seam
  under test, `refreshSubscriptions` (lines ~3221–3266 at planning time):

  ```ts
  private async refreshSubscriptions(changed: Set<string>): Promise<void> {
      const sockets = [...this.state.getWebSockets()];

      const refreshOne = async (ws: WebSocket): Promise<void> => {
          const attachment = this.readAttachment(ws);

          for (const [subId, query] of Object.entries(attachment.subs)) {
              const { functionPath } = query;
              if (!functionPath) { continue; }

              const isAdmin = functionPath.startsWith(ADMIN_FUNCTION_PREFIX);
              const memo = this.subMemos.get(ws)?.get(subId);

              // Skip when we already know this subscription's tables and none
              // of them changed. A missing memo means "unknown deps" — re-run
              // to be safe. A memo carrying the admin wildcard always re-runs …
              if (memo && !memo.tables.has(ADMIN_WILDCARD) && !setsIntersect(memo.tables, changed)) {
                  continue;
              }

              const outcome = isAdmin
                  ? this.executeAdminSubscription(functionPath, query.args ?? {})
                  : await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, query.args ?? {}));

              if (!outcome) { continue; }
              this.pushSubscriptionData(ws, subId, outcome);
          }
      };
      // … bounded fan-out: at most 8 sockets refresh in parallel …
  ```

- `packages/do/__tests__/reactive-cache.integration.test.ts` (578 lines) —
  **your structural exemplar.** It already imports the real machinery:

  ```ts
  import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
  import type { ShardDOOptions, ShardDOState, SubscriptionOutcome } from "../src/shard-do";
  import { ShardDO } from "../src/shard-do";
  ```

  Study it fully before writing anything: how it constructs a `ShardDOState`
  (a fake DO state), wires real SQLite via the helpers, and drives the DO.
- `packages/do/__tests__/_helpers/` — `fake-sql.ts` and `node-sqlite.ts`
  (real-SQLite-in-Node harness). Reuse; do not reinvent.
- Conventions: vitest, no `.js` extensions on relative imports, tests live in
  `packages/do/__tests__/`, ESM.

## Commands you will need

| Purpose        | Command                                                                  | Expected on success |
| -------------- | ------------------------------------------------------------------------ | ------------------- |
| Install        | `pnpm install`                                                           | exit 0              |
| Run do tests   | `pnpm --filter "@cirrus/do" run test`                                    | all pass            |
| Run just yours | `pnpm --filter "@cirrus/do" exec vitest run __tests__/subscription-refresh.integration.test.ts` | all pass |
| Typecheck      | `pnpm --filter "@cirrus/do" run lint:types`                              | exit 0              |

## Scope

**In scope**:

- `packages/do/__tests__/subscription-refresh.integration.test.ts` (create)
- `packages/do/__tests__/_helpers/` — additions ONLY if a fake-WebSocket
  helper is genuinely missing (check first; the exemplar may already fake
  sockets/attachments).

**Out of scope** (do NOT touch):

- `packages/do/src/**` — this plan adds NO production code. If the test
  cannot observe the behavior without a new seam in `shard-do.ts`, that is a
  STOP condition, not a license to refactor.
- `tests/e2e/**`, `packages/client/**`, `packages/runtime/**`.

## Git workflow

- Branch: `test/do-subscription-refresh` off `alpha`.
- Commit style: conventional commits, e.g. `test(do): integration-test mutation→subscription refresh pipeline`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Learn the existing harness

Read `packages/do/__tests__/reactive-cache.integration.test.ts` end to end and
both `_helpers` files. Write down (scratch notes): how `ShardDOState` is
faked; how `getWebSockets()` is satisfied; how a subscription gets registered
(what populates `attachment.subs` and `subMemos`); what message-sending looks
like (what `pushSubscriptionData` ultimately calls on the socket — find it in
`shard-do.ts`); and how a mutation is driven through the DO so that
`refreshSubscriptions(changed)` fires naturally (find its call site(s) in
`shard-do.ts` — prefer driving the public path that calls it over invoking the
private method directly; fall back to direct invocation via a typed cast only
if the public path needs unbuildable infrastructure).

**Verify**: you can answer, from notes, "what fake objects do I need so that
`refreshSubscriptions` runs and I can observe what each socket was sent?"

### Step 2: Build the scenario fixture

In the new test file, construct: a schema with two tables (e.g. `messages`,
`settings`) using the same schema-construction approach as the exemplar; a
ShardDO (or the minimal harness around it the exemplar uses) with real SQLite
via `node-sqlite.ts`; two fake WebSockets:

- socket A with a subscription whose query reads `messages`,
- socket B with a subscription whose query reads `settings`,

each registered the same way the production register path does it (so memos
populate the way they do in production — first successful execute records the
table deps).

**Verify**: `vitest run` on the file — fixture-only test (e.g. "subscriptions
register and receive initial data") passes.

### Step 3: The core assertions

Add tests, each from a fresh fixture:

1. **Targeted refresh**: run a mutation that inserts into `messages`. Assert
   socket A received a new subscription-data frame containing the inserted
   row, and socket B received **nothing** (the memo skip — this is the
   load-bearing assertion of the whole plan).
2. **Memo-miss re-runs to be safe**: register a third subscription but
   prevent/skip its first execute so it has no memo (mirror however the
   exemplar can arrange that; if it can't be arranged without touching src,
   drop this case and note it). Mutate `settings`; assert the memo-less
   subscription re-ran (received a frame) even though its table is unknown.
3. **Delivered data is correct**: after two sequential mutations to
   `messages`, socket A's latest frame reflects both rows (ordering per the
   query).
4. **A failing subscription doesn't break the others**: make one
   subscription's function throw on re-run (e.g. register a function path
   that doesn't resolve, or whatever failure the harness can induce); mutate
   its table; assert the healthy subscription on the same socket still
   received its frame. If `refreshSubscriptions`' behavior is to abort the
   socket loop on throw, record the *actual* behavior in the test name — this
   is a characterization test, not a wish.

**Verify**: `pnpm --filter "@cirrus/do" exec vitest run __tests__/subscription-refresh.integration.test.ts` → all pass.

### Step 4: Full-suite + types

**Verify**: `pnpm --filter "@cirrus/do" run test` → all pass (no interference
with existing suites); `pnpm --filter "@cirrus/do" run lint:types` → exit 0.

## Test plan

The deliverable is the test file (cases listed in Step 3). Model file
structure, naming, and fixture style after
`reactive-cache.integration.test.ts`. Target: one new file, roughly 250–450
lines; if you exceed ~600 lines, you are rebuilding infrastructure the
exemplar already has — go back to Step 1.

## Done criteria

- [ ] `packages/do/__tests__/subscription-refresh.integration.test.ts` exists with at least cases 1, 3, 4 from Step 3 (case 2 optional with a noted reason)
- [ ] Case 1 asserts BOTH the delivery to the affected socket and the non-delivery to the unaffected one
- [ ] `pnpm --filter "@cirrus/do" run test` exits 0
- [ ] `pnpm --filter "@cirrus/do" run lint:types` exits 0
- [ ] `git status` shows no modifications under `packages/do/src/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The exemplar's harness cannot register a *live* subscription with a memo
  (i.e. `attachment.subs` / `subMemos` are populated by infrastructure the
  fake `ShardDOState` cannot reach) and closing that gap requires modifying
  `packages/do/src/**`.
- Observing per-socket sends requires intercepting Cloudflare-runtime-only
  APIs that the Node harness cannot fake.
- After Step 1 you find an existing test already covering Step 3's case 1
  (targeted refresh + memo skip through ShardDO) — report it; this plan may
  be redundant.

## Maintenance notes

- This file is the regression net for any future split of `shard-do.ts`
  (a separately-considered refactor was deliberately deferred until coverage
  like this exists — see `plans/README.md`). Reviewers of future `shard-do.ts`
  changes should expect this suite to stay green untouched.
- If subscription identity/RLS semantics change (`withAnonymousIdentity` in
  the excerpt), case 3's expected rows may legitimately change — update the
  fixture, not the assertions' structure.
