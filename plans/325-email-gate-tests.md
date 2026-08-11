# Plan 325 — Test the signup gate on better-auth's native email path

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. Tests only — no change under `packages/auth/src/`.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/auth/src/email-gate.ts`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`packages/auth/src/email-gate.ts` measures **0% statements, 0% branches, 0% functions**
(145 lines, uncovered 40–129). `packages/auth/__tests__/` has 30 spec files, including
`email-guard.test.ts` for the pure classifier — but nothing for the module that wires
that classifier into better-auth's write path.

This is the only gate on better-auth's **native** `/sign-up/email` route. The module's
own docblock says so: that path never passes through a Lunora procedure middleware. If
`withEmailGate` composes wrong, or the "no email on the record" passthrough widens,
blocked and disposable domains sign up cleanly and no test fails. The failure is
**silent-permissive** — the worst shape for an auth control.

The package passes its floor anyway (measured 86.52/78.20/87.94/86.14 against an
imported 70/80/80/80), because 29 other files carry it.

## 1. Current state (audit)

`packages/auth/src/email-gate.ts` — 145 lines, exported from the package barrel at
`packages/auth/src/index.ts:48-49`:

```ts
export type { EmailGateHookConfig } from "./email-gate";
export { emailGateDatabaseHooks, withEmailGate } from "./email-gate";
```

The three behaviours that matter, all unexecuted by any test:

- **`:66-70`** — a record with no string `email` passes through **ungated**. Correct
  for a social-only record; catastrophic if the condition widens.
- **`:74-82`** — a non-`LunoraError` thrown by `assertEmailAllowed` propagates raw
  instead of becoming a coded better-auth `APIError`.
- **`:117-127`** — `withEmailGate` composes the gate **before** an existing
  `user.create.before` hook. The ordering is the entire contract, and nothing asserts
  it.
- **`:40-55`** — `statusString` maps 400/422/429 with an `INTERNAL_SERVER_ERROR`
  default. Every arm unexecuted.

Read all four before writing tests; the line numbers are from baseline `70b7451b5`.

## 2. Existing seams (do not reinvent)

- **`packages/auth/__tests__/email-guard.test.ts`** — the classifier's spec. Read it
  first: it establishes how this package builds email fixtures, and the gate's spec
  should look like its sibling, not like something imported from another package.
- **The injected classifier.** `email-gate.ts` takes its classifier as configuration
  (`EmailGateHookConfig`), so the tests need no better-auth server and no database —
  pass a stub that accepts or rejects on command.
- `packages/auth/vitest.config.ts:24-28` — this package deliberately imports
  `DEFAULT_COVERAGE_THRESHOLDS`; do not weaken it.

## 3. The behavioural contract to preserve

Tests pin today's behaviour:

1. A blocked domain produces a better-auth `APIError` carrying the domain-blocked code
   and the mapped status.
2. A record with no string `email` is **not** gated (passthrough).
3. A non-`LunoraError` from the classifier propagates unwrapped.
4. `withEmailGate` runs the gate **before** any pre-existing `user.create.before`, and
   when the gate rejects, the caller's hook is **never invoked**.
5. `onClassify` fires on a pass and not on a rejection (verify the actual behaviour
   before asserting — read `:74-100`; if it fires on both, pin that instead and note
   it in §9).

## 4. Design decisions

**Chosen: unit tests against the exported functions with a stub classifier.** Rejected:
an integration test booting better-auth. The composition contract (§3.4) is observable
by calling `withEmailGate` with a spy hook, and a real server turns a 20-line spec into
a fixture project with a database.

**Chosen: assert the error's code and status, not its message.** Messages are copy;
codes are contract.

## 5. Workstreams

### WS1 — `email-gate.test.ts` (S)

New file `packages/auth/__tests__/email-gate.test.ts`. Cases:

1. Blocked domain → the thrown value is a better-auth `APIError` with the
   domain-blocked code and `BAD_REQUEST`.
2. Each `statusString` arm: 400 → `BAD_REQUEST`, 422 → the mapped string, 429 → the
   mapped string, and an unmapped status → `INTERNAL_SERVER_ERROR`. Read `:40-55` and
   assert the actual mapping, not an assumed one.
3. Record with `email: undefined` → the hook resolves and the classifier is never
   called.
4. Record with a non-string `email` (a number, an object) → same passthrough. **This is
   the widening guard**: if someone later loosens the type check, this test reds.
5. Classifier throws a plain `Error` → it propagates unwrapped (not converted to
   `APIError`).
6. `withEmailGate` ordering: given a config with an existing `user.create.before` spy,
   a _passing_ email calls the gate then the spy, in that order; a _rejected_ email
   calls the gate and **never** the spy.
7. `onClassify` on a pass; and its behaviour on a rejection per §3.5.

### WS2 — Confirm the floor still holds (S)

`pnpm --filter "@lunora/auth" run test:coverage` — `email-gate.ts` should move from 0%
to near-full. Do **not** raise the package floor in this plan; plan 321 owns floor
policy, and a floor raised here would collide with it.

## 6. Platform parity

Not applicable — tests only. (`@lunora/auth` is D1-backed and Cloudflare-only today;
this plan changes nothing about that.)

## 7. Phasing & ordering

| Phase | Work | Gate                                                            |
| ----- | ---- | --------------------------------------------------------------- |
| 0     | WS1  | `pnpm --filter "@lunora/auth" run test` green with the new spec |
| 1     | WS2  | `email-gate.ts` no longer reports 0% in the coverage table      |

## Commands you will need

| Purpose      | Command                                              | Expected                              |
| ------------ | ---------------------------------------------------- | ------------------------------------- |
| Build        | `pnpm run build:packages`                            | exit 0                                |
| Tests        | `pnpm --filter "@lunora/auth" run test`              | all pass                              |
| Coverage     | `pnpm --filter "@lunora/auth" run test:coverage`     | exit 0; `email-gate.ts` well above 0% |
| Typecheck    | `pnpm --filter "@lunora/auth" run lint:types`        | exit 0                                |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                                |

## Scope

**In scope:**

- `packages/auth/__tests__/email-gate.test.ts` (create)

**Out of scope:**

- `packages/auth/src/email-gate.ts` and every other source file. A defect found is a
  STOP condition (§8), not an edit.
- `packages/auth/vitest.config.ts` — floor policy belongs to plan 321.
- `email-guard.test.ts` — the classifier is already covered; it is the pattern, not the
  target.
- The `auth-do.ts` / `do-wiring.ts` internal-route gating and `sql-store.ts` quoting —
  both verified clean in a prior wave.

## Git workflow

- Branch: `advisor/325-email-gate-tests`
- Suggested commit: `test(auth): cover the native signup email gate`

## Test plan

WS1 is the test plan: 7 cases, roughly 12 assertions. Model on
`packages/auth/__tests__/email-guard.test.ts`.

Prove case 4 is load-bearing: temporarily change the `typeof email === "string"` check
to a truthiness check, confirm case 4 reds, restore.

## Done criteria

- [ ] `packages/auth/__tests__/email-gate.test.ts` exists and `pnpm --filter "@lunora/auth" run test` exits 0
- [ ] `pnpm --filter "@lunora/auth" run test:coverage` reports `email-gate.ts` above 90% statements and above 80% branches (it is 0/0 today; if a branch is genuinely unreachable, name it in §9)
- [ ] The ordering assertion (case 6) fails if the composition in `withEmailGate` is inverted (prove it)
- [ ] `git diff --stat -- packages/auth/src` is empty
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP and report** if the ordering test shows the gate running _after_ the caller's
  hook, or the passthrough accepting a non-string email in a way that would let a
  blocked domain through. Either is a live auth defect and needs a fix plan, not a
  test-coverage commit.
- **STOP** if better-auth's `APIError` cannot be constructed or asserted without a
  running server. Then the module needs a seam it does not have, and that is a design
  change outside this plan.
- **Risk:** asserting on error _messages_ makes the suite brittle against copy edits.
  Assert codes and statuses.

## 9. Open questions

1. Does `onClassify` fire on rejection as well as on pass? Read `:74-100`, record the
   observed behaviour, and pin whichever it is.
2. Is any branch in `statusString` genuinely unreachable given the classifier's error
   surface? If so, name it — an unreachable branch is a candidate for deletion, not for
   a contrived test.
