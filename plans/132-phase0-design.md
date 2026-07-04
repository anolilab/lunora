# Plan 132 — Phase 0 design: outbound webhook delivery on today's primitives

> **Executor instructions (for the follow-up build plan)**: this document is
> the Phase-0 design deliverable for plan 132 — a DESIGN/SPIKE, not a shipped
> feature. It records the substrate audit, the proposed API + alternatives,
> the wire contract, the SSRF/secret model, the minimal-core-hook verdict, and
> the phased build-out. A companion feasibility prototype lives at
> `apps/playground/__tests__/webhook-delivery-spike.test.ts` (throwaway, not a
> package) and proves the retry → dead-letter → redrive path end to end on the
> unmodified `SchedulerDO`.

## Status

- **Priority**: P2
- **Effort**: spike complete; a build plan (P1–P3 below) would follow
- **Risk**: LOW (no core changes proposed as required; one opt-in hook flagged as optional)
- **Depends on**: `@lunora/scheduler`, `@lunora/payment` (reused, unmodified)
- **Category**: direction
- **Planned at**: 2026-07-04

## Why this matters

Lunora apps regularly need to notify third parties when something happens
(order paid, user signed up, record changed) — the classic "outbound
webhook" feature every SaaS backend eventually grows. Today an app author has
no first-party primitive for this: they'd hand-roll a `fetch()` call inside a
mutation/trigger with no retry, no backoff, no dead-letter visibility, and no
signing convention. This spike asks: **can outbound webhook delivery be built
almost entirely out of primitives Lunora already ships** (`@lunora/scheduler`'s
retry/dead-letter machinery, `@lunora/payment`'s Standard-Webhooks signing
code, the Studio's existing dead-letter panel), or does it need a new core
hook on the mutation/trigger hot path?

**Verdict, up front**: no core hook is required for the primary design.
Everything below — schedule, retry with backoff, dead-letter, manual redrive,
HMAC signing, idempotency — is achievable today by composing existing exports
of `@lunora/scheduler` and `@lunora/payment` from ordinary userland code (a
mutation, or a trigger handler that already receives `ctx.scheduler`). See
["Minimal-core-hook verdict"](#minimal-core-hook-verdict) for the one narrow
exception (queue-based, not scheduler-based, automatic trigger delivery).

## Substrate audit

| Concern                                         | Existing primitive                                               | Evidence                                                                                                                                                                                                                                              | Reusable as-is?                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable retry queue + backoff                   | `SchedulerDO.dispatch()` / `recordRetry()`                       | `packages/scheduler/src/scheduler-do.ts:423` (`protected async dispatch(record): Promise<boolean>` — override seam), `:725` (`recordRetry`), `:57-60` (`DEAD_PREFIX`, `MAX_RETRY_ATTEMPTS = 5`, `RETRY_BASE_DELAY_MS = 30_000`)                       | Yes — override `dispatch()` only                                                                                                                                                                                                                                                   |
| Retry policy shape                              | `RetryPolicy`                                                    | `packages/scheduler/src/types.ts:64-77` (`backoff: "exponential" \| "linear"`, `baseMs`, `maxAttempts`, `maxMs`)                                                                                                                                      | Yes, unmodified                                                                                                                                                                                                                                                                    |
| Per-job record shape                            | `ScheduleRecord`                                                 | `packages/scheduler/src/types.ts:93-118` (`args`, `attempts?`, `enqueuedAt`, `functionPath`, `id`, `instanceName?`, `pool?`)                                                                                                                          | Yes, unmodified — `functionPath` doubles as the delivery's logical event name, `args` as the payload                                                                                                                                                                               |
| Dead-letter store + HTTP surface                | `SchedulerDO` routes                                             | `packages/scheduler/src/scheduler-do.ts:305` (`GET /dead`), `:326` (`POST /dead/cancel`), `:329` (`POST /dead/retry`), `:1017` (`storage.list({prefix: DEAD_PREFIX})`), `:1036` (`storage.get` in `handleDeadRetry`)                                  | Yes, unmodified                                                                                                                                                                                                                                                                    |
| Studio redrive UI                               | `dead-letter-jobs.tsx`                                           | `packages/studio/src/features/logs/dead-letter-jobs.tsx` — `client.listDeadJobs()` / `client.retryDeadJob(id)` / `client.removeDeadJob(id)`, polled via `useAutoRefresh`, columns for function/attempts/last-tried/pool/shard/id + Retry/Drop buttons | Yes, unmodified — a webhook delivery dead-letters into the _same_ store this panel already renders                                                                                                                                                                                 |
| Enqueue API for opt-in delivery                 | `runAfter` / `runAt` / `Workpool.enqueue`                        | `packages/scheduler/src/types.ts:79-91` (`RunOptions{pool?, retry?, shardKey?}`), `:197-204` (`EnqueueOptions`)                                                                                                                                       | Yes — a mutation/trigger calls `ctx.scheduler.runAfter(delayMs, "webhooks.deliver", {url, event, payload}, {retry: {...}})`                                                                                                                                                        |
| Test seam to simulate success/failure           | `dispatch()` override                                            | `packages/scheduler/__tests__/scheduler-do.test.ts` (`FailingScheduler`/`TestScheduler` subclasses), mirrored by this spike's `packages/scheduler/__tests__/fake-state.ts`-style in-memory `SchedulerDOState` fake                                    | Yes — this is exactly how the prototype drives a real HTTP POST through the unmodified retry pipeline                                                                                                                                                                              |
| Fan-out dispatch to _internal_ Lunora functions | `createDispatchRunner`                                           | `packages/dispatch/src/create-dispatch-runner.ts:16` (`SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch"`) — hardwired to POST to the worker's own reserved RPC endpoint with the admin bearer                                                  | **No** — this dispatches _Lunora functions_, not arbitrary external URLs; a webhook delivery must bypass it and POST directly to the tenant's endpoint                                                                                                                             |
| HMAC signing (Standard Webhooks / svix-style)   | `verifyStandardWebhook`                                          | `packages/payment/src/webhook.ts:144` (`verifyStandardWebhook`), `:42` (`hmacSha256Hex`), `:27` (`constantTimeEqual`)                                                                                                                                 | Verifier only — it's inbound-only (checks a signature against a secret); the _signer_ is new (~15 lines in the prototype, mirroring the same wire format)                                                                                                                          |
| Idempotency key derivation                      | `idempotencyKey`                                                 | `packages/payment/src/idempotency.ts` (default export)                                                                                                                                                                                                | Yes, unmodified — `idempotencyKey("webhook.deliver", functionPath, record.id)` gives the receiver a stable dedup key across retries                                                                                                                                                |
| Automatic (table-triggered) emission            | `.triggers()` DSL + `TriggerCtx`                                 | `packages/server/src/schema.ts:197-201` (`afterInsert`/`afterUpdate`/`afterDelete`/`beforeInsert`/…), `packages/server/src/types.ts:947-950` (`TriggerCtx { db, scheduler }`)                                                                         | **Partially** — `ctx.scheduler` is already on `TriggerCtx`, so `.afterInsert((ctx, event) => ctx.scheduler.runAfter(0, "webhooks.deliver", {...}))` works **today, no core change**. Only a _queue_-based (not scheduler-based) trigger path would need a hook — see verdict below |
| Same-transaction trigger firing                 | `runTriggers()`                                                  | `packages/do/src/triggers.ts:82` (`runTriggers`), `:16-19` ("Scope: shard-local/same-backend only... cross-shard follow-up work is **not** transactional")                                                                                            | Confirms triggers fire inline/same-transaction; a webhook's `runAfter` call inside a trigger is deliberately _not_ transactional with the write (correct — network I/O must never block/abort a commit)                                                                            |
| SSRF guard for outbound fetches                 | `validateUrl` / `isPrivateTarget` / `assertResolvedHostIsPublic` | `packages/browser/src/create-browser.ts:91` (`isPrivateIpv4`), `:119` (`isPrivateIpv6`), `:246` (`assertResolvedHostIsPublic`, DNS-rebinding-safe resolve-then-check), `:288` (`isPrivateTarget`), `:333` (`validateUrl`)                             | Logic is reusable in spirit, **not importable** — all module-private in `@lunora/browser`, not re-exported. A webhook delivery path needs the same class of guard (endpoint URLs are tenant-supplied, i.e. attacker-influenced)                                                    |

## API design

### Proposed shape (for the eventual build plan — NOT built in this spike)

```ts
// lunora/webhooks.ts (new user-authored file, same pattern as lunora/queues.ts)
export const orderPaid = defineWebhook({
    retry: { backoff: "exponential", baseMs: 30_000, maxAttempts: 5 },
    // payload type inferred from the emitting call site, mirroring defineQueue
});
```

```ts
// inside a mutation or trigger handler
await ctx.webhooks.orderPaid.deliver({ endpointUrl, payload });
```

Under the hood `ctx.webhooks.<name>.deliver()` is sugar over
`ctx.scheduler.runAfter(0, "webhooks.deliver", { endpointUrl, eventName, payload, secretRef }, { retry })`
— i.e. the same `SchedulerDO` this spike drives directly, plus a small
worker-side `webhooks.deliver` internal function that signs and POSTs.

### Alternatives considered

1. **Bare `ctx.scheduler.runAfter()`, no `defineWebhook` sugar at all.**
   Zero new code — an app author writes the `runAfter` call themselves,
   copy-pasting the sign+POST body from a doc snippet. Rejected as the
   _shipped_ API (too much boilerplate per call site, no per-endpoint secret
   management, no typed payload), but this is exactly what the prototype does
   and is a legitimate "escape hatch" tier even after `defineWebhook` ships.
2. **A `defineQueue`-style consumer (`@lunora/queue`) instead of the
   scheduler.** Cloudflare Queues give at-least-once delivery with a DLQ too,
   but (a) require a wrangler queue binding per queue (heavier ops surface for
   a feature meant to be zero-config), and (b) `@lunora/queue`'s retry model
   is coarser (queue-level `max_retries`, no per-job `RetryPolicy` with
   backoff/`maxMs`). The scheduler's per-job retry policy and existing
   dead-letter HTTP surface are the better fit. Queues remain a documented
   alternative for very high-throughput webhook fan-out (deferred, not
   designed here).
3. **New `packages/webhooks/` package with its own DO.** Rejected per the
   plan's explicit scope — would duplicate `SchedulerDO`'s retry/dead-letter
   logic instead of reusing it, and is unnecessary until endpoint-management
   (subscriptions, per-tenant secrets, delivery-log UI) actually needs its own
   schema/storage, which none of P1's scope requires.
4. **Registering webhook endpoints via schema (`defineTable("webhookEndpoints")`)
   vs. a code-first `defineWebhook`.** A table-first design suits a
   self-serve customer portal (Phase P2/P3, see below); code-first
   `defineWebhook` suits the P1 "deliver to a URL I already know" case. Both
   can coexist — `defineWebhook` producing the payload, an optional
   `webhookEndpoints` table resolving _which_ URLs/secrets a given event
   fans out to.

## Wire contract

The prototype uses the **Standard Webhooks** convention (the same shape
`@lunora/payment`'s `verifyStandardWebhook` already verifies for inbound
payment webhooks), so a single signature convention spans both inbound and
outbound in the framework:

- Headers: `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature: v1,<base64 HMAC-SHA256>`.
- Signed content: `${id}.${timestamp}.${payload}` (exact string concatenation `verifyStandardWebhook` expects — `packages/payment/src/webhook.ts:144`).
- Secret format: `whsec_<base64>`, matching the existing payment convention.
- Idempotency: the sender includes an idempotency key derived via the
  existing `idempotencyKey("webhook.deliver", functionPath, record.id)`
  (`packages/payment/src/idempotency.ts`) as an additional header
  (e.g. `webhook-idempotency-key`) so a receiver can dedupe retried
  deliveries that it actually received but whose 2xx response was lost.
- Retry schedule: whatever `RetryPolicy` the caller supplies
  (`packages/scheduler/src/types.ts:64-77`) — default
  `{backoff: "exponential", baseMs: 30_000, maxAttempts: 5}` inherited
  from the SchedulerDO's built-in defaults (`scheduler-do.ts:59-60`), same
  as any other scheduled job. A receiver returning any non-2xx (or timing
  out) is treated as a failure and re-enters `recordRetry()`
  (`scheduler-do.ts:725`) exactly like a failed internal dispatch.
- Dead-letter: after `maxAttempts` failures the job is parked under
  `dead:<id>` (`DEAD_PREFIX`, `scheduler-do.ts:57`), visible via `GET /dead`
  and manually redrivable via `POST /dead/retry` — both already wired into
  the Studio's `dead-letter-jobs.tsx` panel, so a dead-lettered webhook shows
  up in the _same_ place a dead-lettered internal scheduled job would.

## SSRF / secret model

- **SSRF.** A webhook's `endpointUrl` is tenant-supplied, i.e.
  attacker-influenced input reaching an outbound `fetch()` from inside the
  Worker/DO — the same threat class `@lunora/browser`'s
  `validateUrl`/`isPrivateTarget`/`assertResolvedHostIsPublic` guard against
  for Browser Rendering targets (`packages/browser/src/create-browser.ts:91-362`).
  That logic is **not currently exported** — it's module-private to
  `@lunora/browser`. The build plan should either (a) extract the
  IP/hostname-classification helpers to `shared/` (per the repo's
  `shared/` convention for dependency-free code needed by two otherwise
  unrelated packages/tiers — `@lunora/browser` and whatever hosts webhook
  delivery), or (b) depend on `@lunora/browser` outright if the delivery
  logic already lives behind an action-only boundary. Recommendation: (a),
  since a webhook delivery function should not need to pull in a full
  headless-browser package.
- **DNS rebinding.** `assertResolvedHostIsPublic` already resolves-then-checks
  (not just a syntactic hostname check), closing the classic
  resolve-after-validate TOCTOU gap — the extracted helper should preserve
  that behavior, not just the syntactic `isPrivateTarget` check.
- **Secrets.** Per-endpoint signing secrets are exactly the kind of
  low-volume, per-tenant credential `ctx.secrets` (the core `@lunora/server`
  built-in reading Cloudflare Secrets Store bindings) or a dedicated table
  column (encrypted at rest, e.g. via existing `@lunora/storage`-adjacent
  patterns) could hold — this spike didn't need to pick one, since the
  prototype hard-codes a single `whsec_` test constant, but the design doc
  flags it as a P2 decision once endpoint management exists (an endpoint
  table needs a `secret` column; whether it's stored as ciphertext or a
  `ctx.secrets` reference is an open question below).

## Minimal-core-hook verdict

**No new core hook is required for the primary design.** Concretely:

- **Opt-in delivery from a mutation** — already fully expressible today:
  a mutation calls `ctx.scheduler.runAfter(...)` (or the future
  `ctx.webhooks.<name>.deliver(...)` sugar, which is itself just a thin
  wrapper over the same call). Zero core changes.
- **Opt-in delivery from a trigger** — also already fully expressible
  today, because `TriggerCtx` (`packages/server/src/types.ts:947-950`)
  **already includes `scheduler`**, not just `db`. An
  `afterInsert`/`afterUpdate`/`afterDelete` handler can call
  `ctx.scheduler.runAfter(...)` directly, with the scheduled job running
  outside the write's transaction (correctly — network I/O must never be
  allowed to block or abort a commit; confirmed by
  `packages/do/src/triggers.ts:16-19`'s documented same-backend/non-transactional
  scope for cross-shard follow-up work). Zero core changes.
- **The one narrow exception**: if a future design wants triggers to enqueue
  onto a Cloudflare **Queue** (`@lunora/queue`) rather than the scheduler —
  e.g. to get queue-level batching/backpressure for very high fan-out — that
  requires adding `queues` to `TriggerCtx` (`types.ts:947`), which today
  exposes only `{ db, scheduler }`. This is a small, additive, backward-compatible
  core hook (new optional field on an existing internal interface), not a
  hot-path behavior change, but it IS a `packages/server` source edit and is
  explicitly **out of scope** for this spike. Recommendation: don't build it
  until a real workload demonstrates the scheduler path's throughput is
  insufficient — the scheduler already handles arbitrary concurrency via its
  alarm-driven drain loop and `Workpool` bounded-concurrency option
  (`packages/scheduler/src/types.ts:79-91`, `:197-212`).

This resolves the plan's first STOP condition ("no viable after-commit event
source without core changes AND a minimal hook would touch the mutation hot
path") as **not triggered** — a viable event source (the trigger's existing
`ctx.scheduler`) exists with zero core changes, and even the one hook that
would be needed for the queue-based variant is additive metadata on a context
interface, not a hot-path change.

## Phasing

- **P1 — declare, deliver, retry** (effort: S–M). Ship `defineWebhook` (or
  ship nothing and just document the raw `ctx.scheduler.runAfter()` pattern —
  a valid "P0.5" outcome) plus a worker-side `webhooks.deliver` internal
  function doing sign+POST, reusing `verifyStandardWebhook`'s sibling signer
  and `idempotencyKey` unmodified. Extract the SSRF guard from
  `@lunora/browser` to `shared/` first (small, isolated, no dependency-edge
  risk). No endpoint-management UI — the caller passes `endpointUrl` +
  `secret` explicitly at each call site (or via `ctx.secrets`).
- **P2 — endpoint table + Studio panel** (effort: M). A
  `defineTable("webhookEndpoints")` (url, secret ref, subscribed event names,
  enabled flag) so `ctx.webhooks.<name>.deliver(payload)` can fan out to every
  matching subscribed endpoint without the call site naming a URL. A Studio
  page to list/add/disable endpoints and view recent deliveries (separate
  from, but linking to, the existing dead-letter panel).
- **P3 — redrive UX + per-tenant policies** (effort: S, since redrive already
  exists). The existing `POST /dead/retry` / Studio dead-letter panel already
  covers manual redrive generically — P3 is mostly about surfacing
  webhook-specific context (which endpoint, which event, response body/status
  of the last failure) in that panel, plus optional per-tenant/per-endpoint
  retry-policy overrides layered on the existing per-job `RetryPolicy`.

## Feasibility prototype (evidence)

`apps/playground/__tests__/webhook-delivery-spike.test.ts` (throwaway,
`apps/playground`, not a package) proves:

1. A `SchedulerDO` subclass overriding only `protected dispatch()` drives a
   **real** local `node:http` POST, signed with a Standard-Webhooks-style
   HMAC and verified via the **unmodified** `verifyStandardWebhook` from
   `@lunora/payment` — no scheduler/dispatch source was touched.
2. A forced-failure delivery retries with the configured backoff, then
   dead-letters after exhausting `maxAttempts` — the dead-lettered record is
   observable via the real `GET /dead` HTTP route, unmodified.
3. A transient (single) failure recovers within budget and is never
   dead-lettered nor left in `/list`.
4. A dead-lettered delivery is redriven via the real, unmodified
   `POST /dead/retry` route — the same mechanism the Studio's
   `dead-letter-jobs.tsx` panel already calls — and succeeds once the
   downstream endpoint recovers.

Repro: `pnpm --filter "@lunora/playground" exec vitest run __tests__/webhook-delivery-spike.test.ts`
(3/3 passing, reproducible across repeated runs). `pnpm exec tsc --noEmit -p apps/playground/tsconfig.json`
and `pnpm exec eslint apps/playground/__tests__/webhook-delivery-spike.test.ts`
both report zero errors attributable to this file.

`git status` for this spike touches only:
`apps/playground/package.json` (added `@lunora/payment` devDependency),
`pnpm-lock.yaml`, and the new test file — **no changes under any
`packages/*/src`.**

## Open questions

1. **Standard Webhooks vs. Stripe-style signature convention** — this spike
   picked Standard Webhooks (svix-style) since `@lunora/payment` already
   implements and tests it for inbound verification, giving the framework one
   signature convention end to end. Should the shipped `defineWebhook` also
   offer a Stripe-compatible mode for apps whose receivers already have
   Stripe-webhook-shaped verification code?
2. **Should `@lunora/mcp` expose webhook delivery state** (list recent
   deliveries, redrive a dead-lettered one) alongside its existing
   query/mutation/action surface, once P2's endpoint table exists?
3. **Should the SSRF guard in `@lunora/browser` be extracted to `shared/`**
   (this doc's P1 recommendation), or should webhook delivery instead take a
   direct dependency on `@lunora/browser` for just the guard? The `shared/`
   route avoids a dependency edge between an action-only browser-rendering
   package and a scheduler/webhook delivery path that has nothing else to do
   with headless browsers.
4. **Where do per-endpoint secrets live** (P2)? A `ctx.secrets`-backed
   reference (no plaintext ever touches the table) vs. an encrypted table
   column — needs a decision before `webhookEndpoints` ships.
5. **Queue-based delivery for very high fan-out** — is the scheduler's
   drain loop + `Workpool` bounded concurrency sufficient at expected scale,
   or will a future workload need the `TriggerCtx.queues` hook flagged above?
   Defer until a concrete throughput requirement appears.

## Done criteria

- [x] `plans/132-phase0-design.md` exists with substrate audit, API design +
      alternatives, wire contract, SSRF/secret model, minimal-core-hook
      verdict, phasing, and open questions.
- [x] A minimal prototype proves forced-failure → retry → dead-letter →
      redrive on the unmodified `SchedulerDO`, reproducible
      (`apps/playground/__tests__/webhook-delivery-spike.test.ts`, 3/3
      passing across repeated runs).
- [x] `git status` shows no changes to any `packages/*/src`.

## STOP conditions (evaluated)

- "No viable after-commit event source without core changes AND a minimal
  hook would touch the mutation hot path" — **not triggered**: `ctx.scheduler`
  is already on `TriggerCtx`, so triggered delivery needs zero core changes.
- "The prototype can't express retry/dead-letter with runAfter/SchedulerDO" —
  **not triggered**: proven working in the prototype (3/3 tests).
- "An existing partial webhook implementation is found" — **not triggered**:
  confirmed via repo-wide grep that no outbound webhook implementation
  exists anywhere in the repo prior to this spike.

## Maintenance notes

- If a build plan is written from this design, it should re-verify the
  substrate audit's file:line citations first (this doc is a snapshot as of
  commit `b7d361358`, 2026-07-04) — `@lunora/scheduler`/`@lunora/payment`
  internals may have shifted.
- The prototype is intentionally throwaway (`apps/playground/__tests__/`,
  not a package) — do not promote it in place; a real `defineWebhook`
  implementation should live in a new package or an existing one per the
  P1 phasing above, written fresh against this design.
