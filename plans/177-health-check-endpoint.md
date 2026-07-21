# Plan 177 — Health-check endpoint

- **Category**: feat (DX/ops — Wave 14 visulima reuse, in `plans/README.md`)
- **Priority**: P3
- **Effort**: S · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: ship a first-class health/readiness endpoint for a deployed Lunora
  worker — reporting binding/subsystem health and basic metrics — by reusing
  **`@visulima/health-check`**. A production-readiness win that feeds the
  existing production-checklist.

## Context

Lunora has observability groundwork (traces/metrics in Studio) but no standard
**health/readiness probe** an uptime monitor, load balancer, or Cloudflare Health
Check can hit. `@visulima/health-check` provides service checks + metrics and is
`fetch`-based (edge-safe). It slots into the existing admin-route pattern
(`packages/runtime/src/*-admin-routes.ts`).

## Phase 1

- [ ] A `GET /_lunora/health` (and `/health/ready`) route via the admin-route
      pattern, backed by `@visulima/health-check`.
- [ ] Register checks for the deployment's critical bindings/subsystems: DO
      reachability, D1, R2, and any configured externals (Hyperdrive, queues).
- [ ] Liveness (process up) vs readiness (dependencies healthy) split; return
      standard status + JSON body; keep it unauthenticated-safe (no secrets leaked)
      or admin-gated per config.

## Phase 2 — Surface & docs

- [ ] Studio "Health" indicator; wire the endpoint into the production-checklist
      docs and the deploy verify step.

## Exit criteria

- [ ] `/_lunora/health` returns green when bindings resolve and red/`503` when a
      critical dependency is down, verified on workerd.
- [ ] No secret/PII leakage in the health body; auth posture is configurable.
- [ ] Docs + example (wiring a Cloudflare Health Check / uptime monitor).

## Non-goals

- A full metrics/APM product — this is a probe, not a dashboard (that's the
  observability work + Lunora Cloud).
