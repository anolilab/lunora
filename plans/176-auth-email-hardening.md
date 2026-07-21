# Plan 176 — Auth email hardening (disposable / free-email gating + verification)

- **Category**: feat (security/DX — Wave 14 visulima reuse, in `plans/README.md`)
- **Priority**: P3
- **Effort**: S · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: let apps reject throwaway/disposable signups and reason about
  free-vs-business email at registration, by reusing the visulima email packages
  in `@lunora/auth`. A cheap trust/anti-abuse win enabled by reuse, not a from-
  scratch build.

## Context

`@lunora/auth` (better-auth) already does email verification via the
`emailAndPassword` flow; what it lacks is **domain-based gating** at signup. The
visulima catalog covers this directly and edge-safely:

- **`@visulima/disposable-email-domains`** — blocklist of temporary/throwaway
  domains (pure data → edge-safe).
- **`@visulima/free-email-domains`** — list of free consumer providers (pure data
  → edge-safe); useful to flag/branch B2B signups.
- **`@visulima/email-verifier`** — syntax + domain + MX validation. **Caveat: MX
  verification needs DNS**, which on workerd means DNS-over-HTTPS or scoping the
  MX step out of the edge path; the domain-list checks are pure-data and always safe.

## Phase 1 — Domain gating at signup

- [ ] Add a signup middleware/hook in `@lunora/auth` (`middleware.ts` /
      `create-auth.ts`) that consults `@visulima/disposable-email-domains` and
      rejects disposable addresses with a coded error (`@lunora/errors`).
- [ ] Config knobs: `blockDisposable`, `flagFreeEmail`, custom allow/deny lists;
      expose a resolved `emailClass` (`disposable | free | business`) on the signup
      context for app policy.

## Phase 2 — Optional deeper verification

- [ ] Opt-in `@visulima/email-verifier` syntax + MX validation, with the DNS caveat
      documented; wire it behind a flag so the default path stays pure-data/edge-safe.
- [ ] Advisor lint: signup mutation without disposable gating (pairs with the
      existing `user-creating-mutation-without-captcha` lint).

## Exit criteria

- [ ] A disposable-domain signup is rejected with a clear error; a business email
      passes; behavior is config-gated and defaults sensibly.
- [ ] The default path is edge-safe (no DNS); MX verify is opt-in + documented.
- [ ] Docs + tests.

## Non-goals

- Maintaining the domain lists ourselves — track `@visulima/*` upstream.
- Full email deliverability scoring — this is signup-time gating, not a mail product.
