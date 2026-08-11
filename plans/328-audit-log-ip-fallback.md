# Plan 328 — Stop recording an attacker-chosen IP in the auth audit trail

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/auth/src/audit-hooks.ts packages/runtime/src/create-worker.ts`

## 0. Headline finding

`packages/auth/src/audit-hooks.ts:147-152` resolves the IP it writes into every auth
audit record as:

```
cf-connecting-ip ?? x-forwarded-for[0] ?? x-real-ip
```

The last two are attacker-settable request headers. The runtime refuses to do this
thirty lines of docblock away — `packages/runtime/src/create-worker.ts:1756-1760` uses
`cf-connecting-ip` deliberately and calls raw `x-forwarded-for` "client-spoofable and
deliberately NOT used".

On Cloudflare the fallback is unreachable: `cf-connecting-ip` is edge-set and cannot
be spoofed. Off Cloudflare — a self-hosted `@lunora/auth`, a Node host, or any
topology where the header is absent — an attacker picks the IP recorded against their
own sign-in, lockout and credential-change events. That is the one field a forensic
review of that table depends on.

Bounded impact, low effort, and the inconsistency with the runtime's own stated rule
is what makes it worth closing rather than documenting.

## 1. Current state (audit)

`packages/auth/src/audit-hooks.ts:147-152` — the resolver (read it before editing; the
exact shape may differ slightly from the summary above).

`packages/runtime/src/create-worker.ts:1756-1760` — the rule the rest of the repo
follows, in comment form.

Nothing authorizes on this value; it is audit-log enrichment only. That is why this is
P3 rather than a security incident.

## 2. Existing seams (do not reinvent)

- The runtime's `cf-connecting-ip` handling at `create-worker.ts:1756-1760` — the
  canonical statement of the rule. Match its reasoning and cite it in the comment you
  leave behind.
- Whatever options bag `audit-hooks.ts` already accepts (read the module's exported
  config type). A trusted-proxy setting belongs there, not in a new parameter.

## 3. The behavioural contract to preserve

1. On Cloudflare, behaviour is **unchanged** — `cf-connecting-ip` is present and wins
   today and after.
2. The audit record must still be written when no trustworthy IP is available. Dropping
   the event because the IP is unknown would be a worse failure than an absent field.
3. The field's type must tolerate absence. Check whether it is currently non-nullable
   in the record type; if it is, that is part of the change.

## 4. Design decisions

**Chosen: honest absence by default, opt-in trust.** `cf-connecting-ip` when present;
otherwise `undefined` — unless the caller has explicitly configured a trusted-proxy
mode, in which case the leftmost `x-forwarded-for` entry is used.

Rejected: keeping the fallbacks with a comment. An attacker-chosen value in an audit
row is worse than a missing one — a blank field reads as "unknown", a forged field
reads as evidence.

Rejected: parsing `x-forwarded-for` for "the last untrusted hop". That requires knowing
the proxy chain length, which the library cannot know, and getting it wrong produces
the same forged value with more code.

Rejected: a new dependency for proxy handling. A boolean/option plus taking the
leftmost entry is a few lines; the trust decision is the deployer's, not a library's.

## 5. Workstreams

### WS1 — Narrow the resolver (S)

In `packages/auth/src/audit-hooks.ts`:

- Return `cf-connecting-ip` when present.
- Otherwise return the `x-forwarded-for` leftmost entry **only** when the module's
  config opts into trusting proxy headers; otherwise `undefined`.
- Drop `x-real-ip` entirely — there is no configuration under which it is more
  trustworthy than `x-forwarded-for`, and two knobs for one decision is one too many.
- Leave a comment pointing at `create-worker.ts:1756-1760` so the next reader finds the
  rule rather than re-deriving it.

### WS2 — Surface the option (S)

Add the trusted-proxy flag to the module's existing config type with a docstring that
states the consequence in one line: "when true, `x-forwarded-for` is trusted — only
enable this behind a proxy you control, or the recorded IP is attacker-chosen."

If this changes the package's public surface, run `pnpm run api:check` and update the
snapshot with `pnpm run api:update` **after a fresh build** (it reads `dist/`, so a
stale build writes a wrong snapshot).

### WS3 — Tests (S)

See §Test plan.

## 6. Platform parity

| Feature                     | `cloudflare` | `node`   | Notes                                                                                                                                                              |
| --------------------------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| auth audit-record client IP | native       | emulated | Cloudflare supplies an unspoofable `cf-connecting-ip`; a Node host has no equivalent, so the field is absent unless the deployer opts into trusting a proxy header |

No `ctx.*` surface is added or removed, so no codegen-visible capability changes — but
record the row, because the honest answer differs per target and that is exactly what
the matrix is for.

## 7. Phasing & ordering

| Phase | Work | Gate                                                           |
| ----- | ---- | -------------------------------------------------------------- |
| 0     | WS1  | new tests pass; the Cloudflare path is byte-identical          |
| 1     | WS2  | `pnpm run api:check` clean, or the snapshot updated on purpose |

## Commands you will need

| Purpose      | Command                                              | Expected                                |
| ------------ | ---------------------------------------------------- | --------------------------------------- |
| Build        | `pnpm run build:packages`                            | exit 0                                  |
| Auth tests   | `pnpm --filter "@lunora/auth" run test`              | all pass                                |
| Typecheck    | `pnpm --filter "@lunora/auth" run lint:types`        | exit 0                                  |
| API snapshot | `pnpm run api:check` / `pnpm run api:update`         | exit 0; update only after a fresh build |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                                  |

## Scope

**In scope:**

- `packages/auth/src/audit-hooks.ts`
- the module's config type (same file or its neighbour — read the imports)
- `packages/auth/__tests__/` — one new or extended spec
- `api-snapshots/auth.api.md` only if the surface genuinely changed

**Out of scope:**

- `packages/runtime/src/create-worker.ts` — already correct; it is the reference.
- Every other consumer of `x-forwarded-for` in the repo. If you find one, note it in §9
  rather than widening this plan.
- The audit record's schema beyond making the IP field optional if it is not already.

## Git workflow

- Branch: `advisor/328-audit-log-ip-fallback`
- Suggested commit: `fix(auth): stop trusting spoofable ip headers in the audit trail`

## Test plan

New or extended spec under `packages/auth/__tests__/`:

1. `cf-connecting-ip` present → recorded, and `x-forwarded-for` is ignored even when
   both are present and differ. (Pins §3.1.)
2. No `cf-connecting-ip`, `x-forwarded-for` present, trust **off** (default) → the
   recorded IP is absent. **The regression test.**
3. Same, trust **on** → the leftmost `x-forwarded-for` entry is recorded.
4. `x-real-ip` alone is never recorded, in either mode.
5. No headers at all → the audit record is still written, with the IP absent. (Pins
   §3.2.)

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the five new cases
- [ ] `grep -n "x-real-ip" packages/auth/src/audit-hooks.ts` → no match
- [ ] Case 2 fails when WS1 is reverted (prove it)
- [ ] `pnpm run api:check` exits 0, or the snapshot diff is intentional and reviewed
- [ ] `pnpm --filter "@lunora/auth" run lint:types` exits 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if the audit record's IP field is non-nullable in a way that ripples into a
  stored schema or a migration. Making a column nullable is a data-layer change and
  needs its own plan.
- **STOP** if a consumer (the Studio's security-audit view, an export) renders the IP
  in a way that breaks on absence. Find it before landing; a blank field must render as
  "unknown", not crash a page.
- **Risk:** an existing self-hosted deployment silently loses the IP it used to record.
  That is the intended change — the value it recorded was untrustworthy — but it belongs
  in the changelog entry, with the opt-in named.

## 9. Open questions

1. Are there other `x-forwarded-for` readers in the repo that should follow the same
   rule? List them here; do not fix them in this plan.
2. Should the trusted-proxy option live per-package or as one shared runtime setting?
   One setting is tidier and a bigger change — record the call and the reasoning.
