# Plan 439: Route each push target by its own kind in the composite push provider

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/notify/src/providers.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The composite push provider routes an entire send by the kind of the **first** target: `pick(endpoints[0]).send(payload)`. Its own comment concedes the multi-target case is reachable — "`notify.send()` hands a caller-shaped message straight to the engine, so a multi-recipient push `to` does reach this router, and the provider POSTs all of them" — and the SSRF loop directly above correctly iterates every target. So `ctx.notify.send({ push: { to: [webPushSubscription, fcmToken] } })` hands the FCM token to the Web Push provider (or the reverse): silent misdelivery for any mixed-kind fan-out. The single-target `ctx.push.send`/`broadcast` paths always pass one target, which is why no test catches it.

## Current state

- `packages/notify/src/providers.ts:154-176` (`routingPushProvider`'s `send`):
  ```ts
  send: async (payload) => {
      // ROUTING is on the first target — the endpoint IS the decision, present
      // means web push, absent means FCM — because `ctx.push`'s own fan-out
      // (`deliver`) sends exactly one target per call.
      //
      // The SSRF re-check, though, must cover EVERY target: ...
      const targets = Array.isArray(payload.to) ? payload.to : [payload.to];
      const endpoints = targets.map((entry) => webPushEndpoint(entry));

      for (const endpoint of endpoints) {
          if (endpoint !== undefined) {
              // eslint-disable-next-line no-await-in-loop -- ...
              await assertPushTargetResolvable(endpoint, options.allowedPushOrigins);
          }
      }

      return pick(endpoints[0]).send(payload);
  },
  ```
- `pick` (`providers.ts:132-144`) maps `endpoint === undefined` → FCM provider, defined → Web Push, throwing a directed error when the needed channel is unconfigured.
- Return type: a provider `send` resolves one `Receipt`; the engine's `notify.send` returns `Receipt[]` per channel (`packages/notify/src/types.ts:307`). Read the `Receipt` type in `packages/notify/src/types.ts` (grep `Receipt`) before deciding the merge shape in Step 1.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/notify..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/notify" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/notify" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/notify" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/notify/src/providers.ts` (`routingPushProvider.send` only)
- The providers test file in `packages/notify/__tests__/`

**Out of scope**:
- `webPushEndpoint`, `assertPushTargetResolvable`, `pick`'s unconfigured-channel errors — all correct.
- The engine (`notify.ts`) and `ctx.push` single-target paths.

## Git workflow

- Branch: shared wave branch `improve/wave22-notify`.
- Commit: `fix(notify): route mixed push targets by kind`

## Steps

### Step 1: Partition and send per kind

After the SSRF loop, partition `targets` into `webPushTargets` (where `webPushEndpoint(entry) !== undefined`) and `fcmTargets` (the rest). If only one group is non-empty, behave exactly as today: `pick(...)` that group's provider and send with the original payload but `to` narrowed to that group. If both are non-empty, send each group through its provider (`{ ...payload, to: group.length === 1 ? group[0] : group }` — preserve the scalar-vs-array shape convention the payload type uses; read `PushPayload.to`'s type first) and merge the two receipts.

Merge rule: read the `Receipt` shape; produce a receipt that is successful only if both are, carrying the first failure's error otherwise. If `Receipt` has fields that cannot be merged meaningfully (per-message provider ids etc.), keep the first group's receipt as the return and record the second's failure by throwing on failure — the invariant that must hold: **a failed group must not be reported as success**. If no faithful merge exists at all, STOP and report (the fallback design is a directed "mixed push targets are not supported in one send" error, but do not choose it unilaterally).

Update the routing comment to describe the partition.

**Verify**: `pnpm --filter "@lunora/notify" run test` → existing provider tests pass.

### Step 2: Tests

In the existing providers test file (find it: `ls packages/notify/__tests__/ | grep -i provider`), add: (a) mixed `to: [webPushTarget, fcmToken]` delivers each to its own provider stub (assert each stub's received `to`), (b) single-kind arrays behave as before, (c) a failing group is not masked by a succeeding one. Model the stubs on the existing routing tests in that file.

**Verify**: `pnpm --filter "@lunora/notify" run test` → all pass including 3 new tests.

## Test plan

As Step 2. Existing single-target routing tests must stay green.

## Done criteria

- [ ] `pnpm --filter "@lunora/notify" run test` exits 0 with the 3 new tests
- [ ] `pnpm --filter "@lunora/notify" run lint:types` exits 0
- [ ] `grep -n "endpoints\[0\]" packages/notify/src/providers.ts` → no match

## STOP conditions

- The excerpts don't match the live code.
- The `Receipt` shape admits no merge that keeps "failed group ⇒ not reported success" — report with the shape you found and the proposed alternative.
- The `PushPayload.to` type forbids re-narrowing (unexpected variance) — report.

## Maintenance notes

- If a third push kind ever appears (e.g. APNs direct), the partition generalizes to a group-by; the pairwise merge is the part to revisit.
