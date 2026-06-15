# Plan 038: Pub/Sub (MQTT broker)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 388a6423..HEAD -- packages/config/src/wrangler-validator.ts packages/do/src` then re-verify that Cloudflare Pub/Sub is still **beta / limited availability** before doing anything. On mismatch (e.g. it went GA), re-scope.

## Status

- **Priority**: P3 — beta, limited-availability product; building on it risks churn and a broken story for users who can't get access.
- **Effort**: S (docs-only non-goal) for now.
- **Risk**: LOW — choosing not to build it carries no risk; building on a beta API does.
- **Depends on**: none
- **Category**: non-goal (deferred until GA)
- **Planned at**: commit `HEAD`, 2026-06-15

## Verdict

**Defer until GA. Document as a non-goal with a concrete revisit trigger.** Cloudflare Pub/Sub is an **MQTT broker** still in beta/limited availability — onboarding is gated, the API surface can change, and there is no Worker binding (you talk MQTT over TLS, or use the HTTP/on-publish Worker hook). It also overlaps heavily with what Cirrus already delivers: realtime fan-out is handled by DO-hibernated WebSocket subscriptions in `@cirrus/do` (`ShardDO`), which is type-safe, integrated, and needs no external broker. The only thing Pub/Sub adds is **MQTT-protocol device ingest** (IoT clients that speak MQTT natively) — a real but narrow niche. Until it is GA and someone needs MQTT device ingestion specifically, the right move is to write it down as a non-goal and revisit on the trigger below.

## Current state

- No Pub/Sub / MQTT code anywhere: `grep -ri "mqtt\|pub.?sub\|pubsub" packages/` returns nothing in scope.
- Cirrus's realtime fan-out is the DO-hibernated WebSocket subscription path in `@cirrus/do` (`ShardDO`) plus the query coordinator in `packages/runtime/src/query-coordinator.ts`. This covers browser/server realtime data without any broker.
- `packages/config/src/wrangler-validator.ts` knows nothing about Pub/Sub, and correctly so — Pub/Sub has **no `wrangler.jsonc` binding** (brokers are provisioned via the dashboard/API, not declared in worker config), so there is nothing to add to the validator today.
- The on-publish Worker hook (a Worker invoked per message for auth/transform) is the only integration seam, and it's a normal `fetch` handler — not something Cirrus needs to abstract.

What's missing: nothing. This is a deliberate "do not build yet" decision.

## Item breakdown

- [ ] **Item 1: Record the non-goal + revisit trigger (the whole plan).**
    - Add a short "Why no MQTT/Pub/Sub" note where realtime is documented (the `cirrus-realtime` skill, or a docs page): realtime fan-out is DO-WebSocket-based; MQTT broker ingest is out of scope while Pub/Sub is beta.
    - State the **revisit trigger** explicitly: (a) Cloudflare Pub/Sub reaches GA (general availability, ungated onboarding, stable API), **and** (b) a user needs to ingest from native-MQTT devices into Cirrus. Both must hold.
    - If/when revisited, the likely shape is a tiny on-publish Worker-hook helper in `@cirrus/runtime` that authenticates a message and routes it to a mutation — _not_ a new broker abstraction. Do not pre-build it.
    - No code; docs only.

## Verification

- n/a — docs only. (If the trigger fires and a helper is later added, it will get its own plan with real `pnpm --filter` build/test/lint:types commands.)

## STOP conditions

- If Cloudflare Pub/Sub is still beta/limited-availability at execution time, STOP after Item 1 — do not build any integration.
- If you start designing an MQTT client, broker provisioning, or a topic abstraction inside Cirrus, STOP — that is explicitly out of scope for this plan.
- If a request implies replacing the DO-WebSocket realtime path with MQTT, STOP and escalate — that is a topology change, not this plan.
