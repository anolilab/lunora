# Plan 174 — Auth / security event audit trail

- **Category**: feat (competitive parity — Wave 14 deep-pass, in `plans/README.md`)
- **Priority**: P2
- **Effort**: M · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: record authentication & security events (sign-in, sign-up, token
  refresh, password change, MFA enable/disable, SSO link) to a durable, queryable
  audit trail — the compliance/forensics surface Supabase
  (`auth.audit_log_entries`), Firebase, and Convex (paid) all offer.

## Context (verified)

An audit log already exists but is scoped to **admin state-changing operations**:
`packages/do/src/audit-log.ts` records `writeRow` / `runMigration` / `importShard`
/ `applyCdc` with ~1000-row retention. Grep `-i audit packages/auth/src` yields
only doc-comment mentions — **no auth-event recording anywhere**. better-auth
exposes lifecycle hooks that can feed the same reserved-audit-table pattern.

## Phase 1 — Record auth events

- [ ] Hook better-auth lifecycle events (`packages/auth/src/create-auth.ts` /
      `handler.ts` / `session.ts`) → append to a durable auth-audit store,
      reusing the `do/audit-log.ts` reserved-table pattern (configurable retention,
      not capped at 1000 for compliance use).
- [ ] Capture actor, event type, IP/UA, timestamp, outcome; **redact secrets with
      `@visulima/redact`** (already a `@lunora/do` dependency) and optionally scan
      payloads with `@visulima/secret-scanner`.

## Phase 2 — Query & surface

- [ ] Read API (RLS/admin-gated) + a Studio "Security / audit" page.
- [ ] Optional export tap hook (pairs with plan 170) for SIEM forwarding.

## Exit criteria

- [ ] Sign-in / password-change / MFA-toggle events are recorded and queryable.
- [ ] Retention is configurable; PII/secret redaction verified by tests.
- [ ] Docs + example.

## Non-goals

- A full SIEM — this is a recorded, queryable trail; forwarding is a hook, not a product.
- Duplicating the admin-op audit log — extend the pattern to auth events.
