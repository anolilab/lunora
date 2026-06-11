# Plan 006: Isolate per-subscription errors in ShardDO's refreshSubscriptions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f6a466f..HEAD -- packages/do/src/shard-do.ts packages/do/__tests__/subscription-refresh.integration.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (plan 004's regression net is already merged at `b5b377ce`)
- **Category**: bug
- **Planned at**: commit `2f6a466f`, 2026-06-11

## Why this matters

When a mutation commits, `refreshSubscriptions` re-runs every affected live
subscription on the shard and pushes fresh data over WebSockets. Today a
single subscription whose query throws makes the whole refresh reject: the
per-socket loop has no try/catch, the worker promise rejects, `Promise.all`
short-circuits, and (a) every *other* subscription on the shard silently
misses its update, and (b) the RPC that triggered the write gets an error
response even though its write committed. One bad query (bad args, a
since-deleted function, a handler bug) degrades real-time updates for every
connected client on the shard. The fix: errors in one subscription's refresh
must not affect other subscriptions or the caller's response.

## Current state

- `packages/do/src/shard-do.ts` — the ShardDO class (~3.5k lines).
  `refreshSubscriptions` is at lines ~3221–3287; `pushSubscriptionData`
  directly below it.
- `packages/do/__tests__/subscription-refresh.integration.test.ts` — plan
  004's integration test (448 lines). Its **case 4** (starting ~line 356,
  `it("characterization: fetch returns an error response when a subscription throws during refresh", ...)`
  at line 377) is an explicit *characterization* test that pins the CURRENT
  abort-on-throw behavior. **This plan changes that behavior, so that test
  must be rewritten to assert the new isolation semantics** (see Test plan).

The hot loop as it exists today (`shard-do.ts:3227-3257`, abridged):

```ts
const refreshOne = async (ws: WebSocket): Promise<void> => {
    const attachment = this.readAttachment(ws);

    for (const [subId, query] of Object.entries(attachment.subs)) {
        const { functionPath } = query;
        if (!functionPath) continue;

        const isAdmin = functionPath.startsWith(ADMIN_FUNCTION_PREFIX);
        const memo = this.subMemos.get(ws)?.get(subId);

        if (memo && !memo.tables.has(ADMIN_WILDCARD) && !setsIntersect(memo.tables, changed)) {
            continue;
        }

        const outcome = isAdmin
            ? this.executeAdminSubscription(functionPath, query.args ?? {})
            : await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, query.args ?? {}));

        if (!outcome) continue;

        this.pushSubscriptionData(ws, subId, outcome);
    }
};
// ... 8-way bounded fan-out over sockets via Promise.all(workers)
```

Note there is no try/catch anywhere in `refreshOne` or the worker loop. A
throw from `executeSubscription` (or `executeAdminSubscription`, or
`pushSubscriptionData`) propagates all the way out of `refreshSubscriptions`.

Conventions that apply:
- This file deliberately swallows WS-send failures with empty `catch {}`
  blocks plus a one-line comment (see `pushSubscriptionData`,
  `shard-do.ts:3320-3336`: `/* socket may have been closed mid-flush */`).
- The `subscribe()` method (`shard-do.ts:1876`) documents the invariant:
  "We never throw out of this path — the WS hibernation API treats a thrown
  `webSocketMessage` as a fatal-channel error." `refreshSubscriptions` is
  called from the mutation path, but the same defensive posture applies.
- No injected logger exists in this file; existing failure paths either
  swallow silently with a comment or surface structured error frames.
  Follow what you find in the file — do not introduce a logging dependency.

## Commands you will need

| Purpose        | Command                                                          | Expected on success |
| -------------- | ---------------------------------------------------------------- | ------------------- |
| Install        | `pnpm install`                                                    | exit 0              |
| Tests (do pkg) | `pnpm --filter "@cirrus/do" run test`                             | all pass            |
| One test file  | `pnpm --filter "@cirrus/do" run test -- subscription-refresh`     | all pass            |
| Typecheck      | `pnpm --filter "@cirrus/do" run lint:types`                       | exit 0              |
| Lint           | `pnpm --filter "@cirrus/do" run lint:eslint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/do/src/shard-do.ts` — only the `refreshSubscriptions` method (and,
  if needed, a small private helper next to it).
- `packages/do/__tests__/subscription-refresh.integration.test.ts` — rewrite
  case 4; add the new isolation cases.

**Out of scope** (do NOT touch, even though they look related):
- `executeSubscription` / `executeAdminSubscription` / `pushSubscriptionData`
  themselves — the fix wraps their call sites, it does not change them.
- The memo-skip logic and the 8-way bounded fan-out — behavior-preserving.
- `subscribe()` / `unsubscribe()` — plan 009 touches `unsubscribe`; avoid
  collisions.
- Any client-side packages (`@cirrus/client`, `@cirrus/react`).
- Error *frames* to the client: do NOT invent a new WS error-frame protocol in
  this plan. If you believe the client should be told its subscription is
  broken, note it in the completion report as deferred follow-up.

## Git workflow

- Branch: `fix/do-subscription-refresh-isolation` off `alpha`.
- Conventional commit, e.g. `fix(do): isolate per-subscription errors during refresh`
  (subject imperative, lowercase, ≤50 chars).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Wrap the per-subscription body in try/catch

In `refreshOne` inside `refreshSubscriptions` (`shard-do.ts:3227`), wrap the
execute + push of EACH subscription so a throw is contained to that one
subscription:

```ts
for (const [subId, query] of Object.entries(attachment.subs)) {
    // ... functionPath guard and memo-skip stay exactly as they are ...
    try {
        const outcome = isAdmin ? ... : await this.withAnonymousIdentity(...);
        if (!outcome) continue;
        this.pushSubscriptionData(ws, subId, outcome);
    } catch {
        // A throwing subscription must not abort the refresh of its
        // siblings, nor fail the mutation that triggered it. The memo is
        // left untouched ("unknown deps"), so this subscription re-runs
        // on the next flush and gets another chance.
        continue;
    }
}
```

Load-bearing details:
- The `catch` must NOT delete or modify the memo. A missing/stale memo means
  "re-run to be safe" (see the comment at `shard-do.ts:3238-3241`), which is
  exactly the retry semantics we want.
- Keep the existing `// eslint-disable-next-line no-await-in-loop` comment on
  the await — it is intentional and lint will fail without it.
- Match the file's swallow-with-comment style; no `console.*` unless the file
  already uses it on comparable paths (check first with
  `grep -n "console\." packages/do/src/shard-do.ts`).

**Verify**: `pnpm --filter "@cirrus/do" run lint:types` → exit 0.

### Step 2: Rewrite the case-4 characterization test

In `subscription-refresh.integration.test.ts`, the test at ~line 377 currently
asserts: subscription throws during refresh → the fetch returns an error
response, and the later subscription in iteration order never refreshes ("the
loop aborted before reaching it", ~line 375). Rewrite it (rename to drop
"characterization:") to assert the NEW behavior:

1. The fetch that triggered the mutation returns success (the write committed
   and the refresh no longer rejects).
2. The healthy subscription ordered AFTER the broken one on the same socket
   DOES receive its refresh push.
3. The broken subscription receives nothing (no error frame, no data frame).

Keep the test's existing arrange machinery (the "return null first, throw on
subsequent calls" setup described at lines 356-375) — only the assertions
change.

**Verify**: `pnpm --filter "@cirrus/do" run test -- subscription-refresh` → all pass.

### Step 3: Add a cross-socket isolation case

New test in the same file, modeled on case 4's setup: broken subscription on
socket A, healthy subscription on socket B, both depending on the mutated
table. Assert socket B receives its push. (This guards the worker-level
`Promise.all` path, not just the per-socket loop.)

**Verify**: `pnpm --filter "@cirrus/do" run test -- subscription-refresh` → all pass, including the new case.

### Step 4: Full package gate

**Verify**: `pnpm --filter "@cirrus/do" run test` → all pass (42+ test files);
`pnpm --filter "@cirrus/do" run lint:eslint` → exit 0.

## Test plan

- Rewritten: case 4 → mutation succeeds + later same-socket subscription still
  refreshes + broken subscription stays silent.
- New: cross-socket isolation (step 3).
- Pattern to follow: the existing cases in
  `subscription-refresh.integration.test.ts` (same file).
- Verification: `pnpm --filter "@cirrus/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@cirrus/do" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/do" run test` exits 0
- [ ] `grep -n "characterization: fetch returns an error response" packages/do/__tests__/subscription-refresh.integration.test.ts` returns no matches (the old behavior is no longer pinned)
- [ ] `git status` shows changes only in the two in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `refreshSubscriptions` no longer matches the excerpt (someone refactored the
  fan-out since `2f6a466f`).
- Rewriting case 4 reveals the throw is caught somewhere else already (i.e.
  the abort behavior changed independently) — the premise is gone.
- Containing the error requires modifying `executeSubscription` or
  `pushSubscriptionData` themselves (out of scope; the design needs a
  maintainer decision).
- The cross-socket test (step 3) fails for a reason unrelated to error
  isolation (e.g. memo-skip interactions) after one reasonable fix attempt.

## Maintenance notes

- Deferred follow-up (deliberately out of scope): sending the client a
  structured "your subscription is broken" frame so it can stop waiting /
  resubscribe. Needs a protocol decision in `@cirrus/client` too.
- Deferred: a repeated-failure circuit breaker (a subscription that throws on
  every flush re-runs forever because its memo stays stale). Bounded by the
  32-subscriptions-per-socket cap, so acceptable for now; revisit if profiling
  shows hot shards burning time on always-failing queries.
- Reviewers should scrutinize: that the `catch` does not widen past the
  per-subscription body, and that the memo is genuinely untouched on failure.
- Any future split of `shard-do.ts` (the known god-file finding) must keep the
  rewritten tests green — they are the regression net for this semantics.
