# Plan 127: Fix the off-by-one deadLettered flag in queue capture (and its mislabeled constant)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/queue/src/dispatch.ts packages/queue/__tests__/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (dev-display field only; real ack/retry forwarding untouched)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

The queue capture layer (feeding the dev queue-catcher and the Studio Queues
panel) marks a message `deadLettered` when `attempts >= maxRetries`. But
`maxRetries` maps to Cloudflare's `max_retries` — verified:
`packages/config/src/reconcile-bindings.ts:564` writes
`consumer.max_retries = queue.tuning.maxRetries` into wrangler config — and
Cloudflare's semantics are: total deliveries = 1 initial + `max_retries`
retries, with `message.attempts` counting deliveries (first delivery = 1).
Dead-lettering happens when the delivery with `attempts === maxRetries + 1`
fails, i.e. `attempts > maxRetries`. The current `>=` fires one delivery
early: with the default of 3, a message failing its 3rd delivery still has a
retry left, yet Studio shows it as dead-lettered. The root cause is a
mislabeled constant — its comment calls it "max delivery attempts", conflating
retries with deliveries.

## Current state

- `packages/queue/src/dispatch.ts:91-92`:

    ```ts
    /** Cloudflare Queues' default max delivery attempts before a message is dead-lettered. */
    const DEFAULT_MAX_RETRIES = 3;
    ```

    (Cloudflare's default `max_retries` IS 3 — the value is right, the label
    "delivery attempts" is wrong.)

- `packages/queue/src/dispatch.ts:218` — `const maxRetries = typeof entry.definition.maxRetries === "number" ? entry.definition.maxRetries : DEFAULT_MAX_RETRIES;`
- `packages/queue/src/dispatch.ts:225-240` — the flag:

    ```ts
    const attempts = typeof message.attempts === "number" ? message.attempts : 1;

    return {
        attempts,
        body: message.body,
        deadLettered: outcome !== "ack" && attempts >= maxRetries,
        …
    ```

- `packages/queue/src/dispatch.ts:53` — the field's doc comment: "`true` when
  this non-ack disposition exhausted the queue's `maxRetries` (dead-letters
  next)." — note the _intent_ is "dead-letters next", which for CF semantics
  is exactly `attempts > maxRetries` on a failed delivery (after this failed
  delivery, `attempts` deliveries have happened = 1 + (attempts-1) retries;
  retries are exhausted when attempts-1 === maxRetries).

- `packages/queue/src/types.ts:141` — the user-facing option `maxRetries?: number`
  with (line 134) "Name of the dead-letter queue messages land in after
  `maxRetries`."

- Consumers of the flag: the dev queue-catcher persists it
  (`packages/do/src/queue-catcher.ts`) and the Studio queues panel renders it.
  Neither applies its own correction — fixing the producer fixes both.

Conventions: commit type `fix`; vitest with `expect.assertions`.

## Commands you will need

| Purpose      | Command                                                        | Expected on success |
| ------------ | -------------------------------------------------------------- | ------------------- |
| Build deps   | `pnpm --filter "@lunora/queue..." run build`                   | exit 0              |
| Queue tests  | `pnpm --filter "@lunora/queue" run test`                       | all pass            |
| Types / lint | `pnpm --filter "@lunora/queue" run lint:types` / `lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/queue/src/dispatch.ts` (the comparison + the two comments)
- `packages/queue/__tests__/` (expectation updates + new boundary tests)

**Out of scope**:

- Real ack/retry forwarding (`dispatch.ts:131/144` area) — behavior is
  correct; do not touch.
- `packages/do/src/queue-catcher.ts`, the Studio panel, `types.ts`'s option
  semantics, `reconcile-bindings.ts`.
- Renaming `maxRetries` anywhere (public API).

## Git workflow

- Branch: `advisor/127-queue-deadletter-flag`
- Suggested commit: `fix(queue): deadLettered flag fires one delivery early vs max_retries`.

## Steps

### Step 1: Fix the comparison and the comments

- `deadLettered: outcome !== "ack" && attempts >= maxRetries,` →
  `deadLettered: outcome !== "ack" && attempts > maxRetries,`
- Fix the constant's comment to: "Cloudflare Queues' default `max_retries`
  (retries after the initial delivery; total deliveries = 1 + max_retries)."
- Keep the field docstring at line 53 but make it exact: "`true` when this
  failed delivery was the message's last (its retries are exhausted — the
  broker dead-letters it)."

**Verify**: `pnpm --filter "@lunora/queue" run test` — expect a small number
of existing expectation failures at the old boundary; update ONLY assertions
about `deadLettered` at `attempts === maxRetries`.

### Step 2: Boundary tests

In the existing dispatch test file (find it: `ls packages/queue/__tests__/`),
add a boundary triple with `maxRetries: 3` and a failing outcome:

1. `attempts: 3` → `deadLettered: false` (one retry remains — the regression
   this plan fixes).
2. `attempts: 4` → `deadLettered: true`.
3. `attempts: 4, outcome ack` → `deadLettered: false` (success is never
   dead-lettered).

Model the message/entry fixtures on the file's existing tests.

**Verify**: `pnpm --filter "@lunora/queue" run test` → all pass incl. the 3
new tests.

## Test plan

Covered by Step 2. No other packages need test changes (the do/studio
consumers render the flag verbatim).

## Done criteria

- [ ] `grep -n 'attempts >= maxRetries' packages/queue/src/dispatch.ts` → 0 matches
- [ ] The 3 boundary tests exist and pass
- [ ] `pnpm --filter "@lunora/queue" run test` → all pass
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- You find evidence that `entry.definition.maxRetries` is documented anywhere
  as **total deliveries** (docs or types prose contradicting
  `reconcile-bindings.ts:564`'s CF mapping) — the semantics decision then
  belongs to the maintainer.
- A do/studio test asserts the old boundary (would mean a consumer bakes in
  the off-by-one — report before touching another package).

## Maintenance notes

- If Lunora ever surfaces a _predicted_ "will dead-letter next" hint, that is
  `attempts === maxRetries` on failure — don't confuse it with this flag.
- Reviewers: confirm no change within the `ack`/`retry` forwarding block.
