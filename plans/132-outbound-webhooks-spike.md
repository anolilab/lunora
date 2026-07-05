# Plan 132: [Spike] Design outbound webhook delivery on the existing queue/scheduler/dispatch machinery

> **Executor instructions**: This is a DESIGN/SPIKE plan — the deliverable is
> a design doc plus a minimal feasibility prototype, NOT a shipped feature.
> Follow the steps, honor the STOP conditions, and when done update the
> status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/queue/src packages/scheduler/src packages/dispatch/src packages/payment/src/providers`
> Read the live shapes if drifted; the asymmetry this spike addresses is
> structural, not line-anchored.

## Status

- **Priority**: P3
- **Effort**: M–L (spike: M; the shipped feature: L)
- **Risk**: MED for the feature (delivery semantics — signing, retries,
  dedupe — must be right the first time; consumers build on them)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

Lunora handles **inbound** webhooks first-class (payment providers verify
Stripe/Polar signatures via `constructEvent`/`verifyWebhook`), but has **no
outbound delivery**: nothing lets an app say "when X happens, POST a signed
event to my customer's/other system's URL, retried until acknowledged."
That's a top-tier backend ask for a Convex-class product (Convex, Supabase,
and every BaaS competitor ship or roadmap it), and — the reason it's
disproportionately cheap here — every hard part already exists as a shipped
primitive: durable scheduling with retry/backoff and a dead-letter store
(`@lunora/scheduler`'s `runAfter`/`SchedulerDO`), typed queue producers +
consumers (`@lunora/queue`), a server-initiated function-call runner
(`@lunora/dispatch`), idempotency keys (payment layer), HMAC signing
(auth/payment utilities), and Studio observability panels to surface delivery
state. The spike's job is to pick the composition, define the API, and prove
the loop — not to build the product.

## Current state

- Inbound-only asymmetry: `packages/payment/src/providers/stripe.ts` /
  `polar.ts` verify inbound signatures; `grep -rn "defineWebhook\|deliverWebhook\|sendWebhook" packages/` → no hits.
- Available substrate (verify each surface before designing on it):
    - `@lunora/scheduler`: `runAfter`/`runAt` + `SchedulerDO` with retry
      policies and a dead-letter store (see `packages/scheduler/src/scheduler-do.ts`
      — per-job `RetryPolicy` merged over DO defaults, ~line 196+).
    - `@lunora/queue`: `defineQueue` → typed `ctx.queues.<name>` producers +
      generated consumers; capture/observability already in Studio.
    - `@lunora/dispatch` (internal, bundled into queue/workflow):
      `createDispatchRunner` — server-initiated Lunora function calls against
      `/_lunora/scheduler/dispatch` with `LUNORA_ORIGIN_URL` +
      `LUNORA_ADMIN_TOKEN`.
    - Mutation-side event capture candidates: DO triggers / the op-log (a
      mutation's committed changes are already observable server-side — find
      the trigger surface: `grep -rn "trigger" packages/server/src/schema.ts | head`).
- Design constraints from repo principles:
    - **"Scale invisibly"** — prefer zero-config defaults (a webhook is a
      declaration, not an infrastructure setup).
    - Heavy add-ons are separate packages (`@lunora/webhooks` or a
      `@lunora/mail`-style shape); core stays lean.
    - Egress security precedent: `packages/browser`'s SSRF guard
      (protocol/private-IP/credential-strip + DNS-rebinding checks) — outbound
      webhook URLs are user-supplied egress and need the same class of guard;
      reuse/extract rather than reimplement.
- Prior-art contracts worth matching (research step): Standard Webhooks spec
  (signature header format, timestamp tolerance), Svix-style endpoint
  management, Stripe's signed-payload format (`t=…,v1=…`).

## Commands you will need

| Purpose           | Command                                                   | Expected on success  |
| ----------------- | --------------------------------------------------------- | -------------------- |
| Explore surfaces  | greps above                                               | evidence for the doc |
| Prototype harness | `pnpm --filter "@lunora/testing" run test` etc. as needed | green                |

## Scope

**In scope** (deliverables):

- `plans/132-phase0-design.md` — the design doc
- A minimal feasibility prototype proving the delivery loop with existing
  primitives ONLY (no new package yet): e.g. a playground mutation enqueues a
  delivery job via `runAfter`, a handler POSTs a signed payload to a local
  catcher, a forced failure retries per policy and dead-letters into the
  existing store. Throwaway; lives in `apps/playground` or a test harness.

**Out of scope**:

- Creating `packages/webhooks/`.
- Endpoint-management UI, portal, or docs.
- Any change to scheduler/queue/dispatch source.

## Git workflow

- Branch: `advisor/132-outbound-webhooks-spike`
- Commit the design doc as `docs(plans): outbound webhook delivery design (plan 132)`.

## Steps

### Step 1: Substrate audit

Verify each capability the design will lean on, with file:line evidence:
scheduler retry/backoff + dead-letter semantics; queue producer/consumer
typing; where a mutation commit can fan out an event (triggers/op-log — this
is the key unknown: is there a stable server-side "after commit" hook an
add-on can subscribe to without core changes? If not, the design must state
the minimal core hook needed); the browser package's SSRF guard reusability.

### Step 2: API design

Design the developer surface, with alternatives considered:

- Declaration: e.g. `defineWebhooks` in `lunora/webhooks.ts` (matching the
  `defineQueue`/`defineFlags` codegen-discovery pattern) mapping event names →
  table/mutation sources; vs. an imperative `ctx.webhooks.emit(event, payload)`.
- Endpoint registry: static config vs a Lunora table (dynamic, per-tenant
  endpoints — the multi-tenant case is the realistic one; a table also gives
  Studio a free management surface).
- Delivery contract: Standard-Webhooks-compatible signature header, a
  timestamp with tolerance window, an idempotency key per (event, endpoint) —
  spell out the header format; payload schema versioning.
- Retry policy: defaults (e.g. exponential, ~24h horizon), per-endpoint
  overrides, dead-letter → Studio visibility, manual redrive (queue panel
  precedent).
- Security: SSRF guard on endpoint URLs (registration-time AND send-time),
  secret storage (per-endpoint signing secret via ctx.secrets / table),
  no-follow-redirects policy.

### Step 3: Feasibility prototype

Build the Step-2-agnostic loop from "In scope". Success = a forced-failure
delivery observably retries and dead-letters using ONLY today's primitives.
Record what was awkward — those are the add-on's real APIs.

### Step 4: Write `plans/132-phase0-design.md`

Contents: substrate-audit table, the chosen API with alternatives, the wire
contract (headers, signature, retries), the SSRF/secret model, what (if any)
minimal core hook is required, phasing (suggested: P1 declare+deliver+retry;
P2 endpoint table + Studio panel; P3 redrive + per-tenant policies), effort
per phase, open questions for the maintainer (e.g. Standard Webhooks
compliance vs Stripe-style; whether `@lunora/mcp` should expose delivery
state).

## Test plan

Spike-level: the prototype's observable retry/dead-letter run, documented in
the doc with the commands to reproduce. The doc must specify the shipped
feature's test matrix (signature verification round-trip, retry schedule,
SSRF rejection, idempotent redelivery).

## Done criteria

- [ ] `plans/132-phase0-design.md` exists: substrate table with evidence, API + alternatives, wire contract, security model, core-hook verdict,
      phases + estimates, open questions
- [ ] Prototype evidence: forced failure → retries → dead-letter, reproducible
      from the doc
- [ ] No changes to any `packages/*/src` (`git status`)
- [ ] `plans/README.md` status row updated (SPIKE DONE + one-line recommendation)

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds NO viable after-commit event source without core changes AND
  the minimal core hook would touch the mutation hot path (that trade-off is
  the maintainer's, not the spike's).
- The prototype cannot express retry/dead-letter with `runAfter`/`SchedulerDO`
  as documented (substrate gap — record it; it changes the design's
  foundation).
- You find an existing partial implementation (grep once more for
  `webhook` across packages/ and plans/) — reconcile instead of duplicating.

## Maintenance notes

- If built, the delivery contract (signature header, retry schedule) becomes
  a **public, versioned promise** — consumers hard-code verification; the
  design doc must include a versioning story before any code ships.
- Interlock: plan 077's external-source ingest and this feature are the two
  halves of "Lunora talks to external systems" — keep their config surfaces
  stylistically aligned (`.source()` / `defineWebhooks`).
