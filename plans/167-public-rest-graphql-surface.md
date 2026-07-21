# Plan 167 — Opt-in public REST / GraphQL surface

- **Category**: feat (competitive parity — gap #9 in `plans/README.md` Wave 14)
- **Priority**: P3
- **Effort**: L · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: expose an **opt-in** HTTP REST (and optionally GraphQL) surface over
  declared procedures so non-TS clients, webhooks-in, and no-code tools
  (Zapier/n8n) can call a Lunora deployment — closing the interop gap vs
  Supabase's PostgREST + GraphQL, without displacing typed RPC as the primary
  contract.

## Context (verified)

An OpenAPI/OpenRPC **spec** is already generated
(`packages/cli/src/util/api-spec.ts`, wired into codegen/prepare/deploy/verify),
but there is no runtime REST CRUD surface — clients must speak the typed RPC.
That blocks any consumer that can't import the TS client.

Design constraint: everything must route **through procedures** so RLS/auth
(`ctx.auth`) and validators are enforced — no direct table CRUD that bypasses them.

## Phase 1 — REST over procedures (opt-in)

- [ ] Per-procedure opt-in (`.expose({ rest: true })` or schema annotation) so the
      surface is deliberate, never automatic.
- [ ] Runtime router mapping exposed procedures → REST endpoints
      (`packages/runtime/src/*-admin-routes.ts` pattern), enforcing auth + RLS +
      validators.
- [ ] Make the existing OpenAPI spec (`api-spec.ts`) describe exactly the exposed
      REST surface (single source of truth).
- [ ] Rate-limit hookup (`@lunora/ratelimit`) on the public surface.

## Phase 2 — GraphQL (optional, demand-gated)

- [ ] Generate a GraphQL schema from exposed procedures + the data model; resolvers
      delegate to the same procedure path. Only if there's demand.

## Exit criteria

- [ ] An exposed procedure is callable over REST with auth + RLS enforced.
- [ ] The published OpenAPI matches the live REST surface (contract test).
- [ ] Non-exposed procedures are unreachable over REST (default-closed).
- [ ] Docs: "public API surface" guide + security guidance.

## Non-goals

The RPC-first boundary is documented on the
[Design boundaries](../apps/docs/src/content/docs/non-goals.mdx) page
(`/docs/non-goals`, "RPC-first, not REST-first") — state it there, not inline.

- REST/GraphQL becoming the primary contract — typed RPC stays primary.
- Auto-CRUD directly on tables (would bypass RLS) — always via procedures.
