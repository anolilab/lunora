# Plan 332 — Spike: what would a payment-provider conformance suite actually assert?

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO — **spike.** The deliverable is a decision with evidence, not a suite.

> **Executor instructions**: this is an investigation. Its output is §7's decision
> record and, at most, one small proof-of-concept. **Do not build a full TCK.** If you
> find yourself writing the fifth shared assertion, stop and write up what you learned.
> Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first):** `git diff --stat 70b7451b5..HEAD -- packages/payment`
>
> **Depends on:** plan 320 (Stripe/Polar money-method tests). Run this **after** 320
> lands — the shared assertions are much easier to see once all six providers have
> comparable coverage, and 320's cases are half the input to §5's inventory.

## 0. Headline finding

`@lunora/payment` has the contracts-plus-N-adapters shape that already earned a
conformance TCK one package over, and nothing shared to hold the adapters to it.

- `packages/payment/src/adapter.ts:49-93` defines `PaymentAdapter`: ~20 methods, four
  of them optional (`checkEntitlement`, `getBalances`, `reportUsage`, and others —
  read the interface).
- `packages/payment/src/providers/` holds six implementations plus `not-supported.ts`.
- `packages/payment/src/types.ts:34-45` introduces `ProviderCapabilities` —
  "What a provider can do — encoded in types so tax/UX assumptions aren't tribal
  knowledge" — with `merchantOfRecord`, `portal`, `usageMetering`.
- `packages/payment/__tests__/providers/` holds six independent test files. There is no
  shared or parameterized suite: no `describe.each`, no conformance import, anywhere in
  the payment tests.

So **nothing asserts that a provider's behaviour matches its own capability entry**,
and a per-provider test file structurally cannot see a provider that implements the
contract differently from its siblings.

The repo has solved this exact shape once: `@lunora/platform` publishes `./conformance`
and `./conformance/suite` (`packages/platform/package.json:40-47`), and `CLAUDE.md`
records why — the TCK versions in lockstep with the contracts it asserts.
`scripts/check-roadmap-tiers.js` documents the cost of the alternative: two
hand-maintained copies of one taxonomy "had already drifted by eight packages before
anyone noticed".

The drift is not hypothetical here either: an audit found `packages/react/src/payment.tsx:6-23`
hand-mirroring `Subscription` with `provider: "polar" | "stripe"` while
`types.ts:31` has five providers — a client-side type two providers behind, invisible
to `api:check` and `lint:types` because both sides compile fine in isolation.

## 1. What this spike must produce

Four artefacts, all recorded in §7 of this file:

1. **The shared-assertion inventory.** Read all six spec files and list every assertion
   that appears in three or more of them, in the form "given X, the adapter returns Y".
   That list is the candidate suite. If it is short (say under eight), the answer is
   `describe.each`, not a TCK — say so.
2. **The capability-behaviour map.** For each of the three `ProviderCapabilities`
   flags, state whether it is _behaviourally assertable_ (a test can prove the flag
   true or false by calling the adapter) or _documentation-only_. `portal` looks
   assertable (`createPortalSession` returns a URL or the not-supported behaviour);
   `merchantOfRecord` looks like a tax/invoice-ownership claim no unit test can
   observe. Be specific — this is the crux, because a TCK that cannot check the matrix
   only checks method shapes, and TypeScript already does that.
3. **The optional-method policy.** `PaymentAdapter` has optional methods and there is a
   `not-supported.ts`. Establish the rule: must an adapter that declares
   `usageMetering: false` omit `reportUsage`, or provide it and throw a specific error?
   Read `not-supported.ts` and the six providers, and record what they actually do —
   including any disagreement, which is itself a finding.
4. **The sizing.** `describe.each` over the six existing files versus a published
   `@lunora/payment/conformance` subpath. Estimate each in files touched and hours, and
   recommend one.

## 2. Existing seams (do not reinvent)

- `packages/platform/src/conformance/` and its two published subpaths — the in-repo
  precedent. Read how the suite is parameterized, how a host opts into it, and how the
  pure suite is split from the reference-host barrel. Do not copy it wholesale;
  understand _why_ it is split that way and whether payment has the same need.
- `packages/payment/src/adapter.ts` — the contract. It is already an interface with a
  registry (`createAdapterRegistry`, `:110`); a suite would run against
  `registry.all()`.
- `packages/payment/src/providers/not-supported.ts` — whatever the "this provider does
  not do that" convention is, it already exists here.
- The six existing spec files — the input to artefact 1. They are the evidence, not the
  thing to replace.

## 3. The behavioural contract to preserve

This spike changes no behaviour. If the proof-of-concept in §5 reveals that a provider
diverges from its siblings, that is a **finding to report**, not a provider to fix —
each divergence is a decision (fix the provider, or widen the contract) and belongs to
whoever owns that provider.

## 4. Design decisions (to make, not made)

The point of the spike is to make these with evidence:

- **`describe.each` vs a published TCK.** `describe.each` is cheap, lives beside the
  code, and cannot be run by a third party writing their own adapter. A published
  subpath can, and costs a versioned public surface. `@lunora/platform` chose the
  subpath because external hosts are the _point_ — is that true for payment providers?
  Is there any evidence of someone writing a provider outside this repo?
- **Where a shared suite lives.** A test-only helper in `packages/payment/__tests__/`,
  or `packages/payment/src/conformance/` published as a subpath. Only the second needs
  an API-snapshot decision.
- **Whether `ProviderCapabilities` should be asserted at all**, given artefact 2. If
  only one of three flags is behaviourally checkable, say so plainly — a "capability
  conformance suite" that checks one boolean is a misleading name for a useful small
  test.

## 5. Workstreams

### WS1 — Read and inventory (S)

Read all six provider implementations and all six specs. Produce artefacts 1–3 in §7.
No code.

### WS2 — One proof of concept (S)

Take the **single strongest** shared assertion from artefact 1 — the one appearing in
the most spec files — and write it once as a parameterized test over
`registry.all()` (or over the six adapters directly, whichever the existing test
harness makes natural). Run it.

Two outcomes, both valuable:

- **All six pass** → the shared assertion is real and the approach works; record the
  effort it took as the unit cost for the rest.
- **One or more fail** → you have found a live divergence. Record it precisely
  (provider, assertion, expected, actual) and **stop** — §3 applies.

### WS3 — Recommend (S)

Write artefact 4 and a recommendation in §7. If the recommendation is "do nothing",
say so with the reasoning — that is a legitimate and useful outcome, and recording it
stops the finding being re-filed next wave.

## 6. Platform parity

Not applicable — provider adapters inside one package, no `ctx.*` surface and no
binding. (Worth noting in the write-up: `@lunora/payment`'s providers are HTTP APIs,
so they are host-portable in a way DO-backed features are not. That is an argument
_for_ a portable suite, if you find one.)

## 7. Decision record (fill this in — it is the deliverable)

### Artefact 1 — shared assertions (appearing in ≥3 of the six specs)

| #   | Assertion | Appears in |
| --- | --------- | ---------- |
|     |           |            |

### Artefact 2 — capability-behaviour map

| Capability         | Behaviourally assertable? | How, or why not |
| ------------------ | ------------------------- | --------------- |
| `merchantOfRecord` |                           |                 |
| `portal`           |                           |                 |
| `usageMetering`    |                           |                 |

### Artefact 3 — optional-method policy

What the six providers actually do, and whether they agree:

### Artefact 4 — sizing and recommendation

| Option                | Files touched | Estimate | Notes |
| --------------------- | ------------- | -------- | ----- |
| `describe.each`       |               |          |       |
| published TCK subpath |               |          |       |

**Recommendation:**

### Divergences found (if any)

| Provider | Assertion | Expected | Actual |
| -------- | --------- | -------- | ------ |

## Commands you will need

| Purpose       | Command                                              | Expected |
| ------------- | ---------------------------------------------------- | -------- |
| Build         | `pnpm run build:packages`                            | exit 0   |
| Payment tests | `pnpm --filter "@lunora/payment" run test`           | all pass |
| Coverage      | `pnpm --filter "@lunora/payment" run test:coverage`  | exit 0   |
| Typecheck     | `pnpm --filter "@lunora/payment" run lint:types`     | exit 0   |
| Format, lint  | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0   |

## Scope

**In scope:**

- Reading `packages/payment/src/**` and `packages/payment/__tests__/**`
- This file's §7
- At most one new parameterized test file under `packages/payment/__tests__/` (WS2)

**Out of scope:**

- Building the full suite. That is the _next_ plan, if §7 recommends one.
- Changing any provider implementation. A divergence is a report (§3).
- `packages/react/src/payment.tsx`'s drifted `Subscription` mirror — a real, separate
  finding: `provider` is two members behind and `currentPeriodStart` is missing. It
  motivates this spike but is not fixed by it. File it separately if it is not already
  filed.
- Webhook verification and the subscription state machine — verified clean in a prior
  wave.
- Adding a seventh provider.

## Git workflow

- Branch: `advisor/332-payment-conformance-spike`
- Suggested commit: `test(payment): spike a shared provider assertion`
- If the outcome is "do nothing", the commit is this file's §7 alone. That is a valid
  deliverable — the reasoning is the artefact.

## Done criteria

- [ ] All four artefacts in §7 are filled in with specifics, not adjectives
- [ ] WS2's proof of concept exists and has been run; its outcome is recorded
- [ ] Any divergence found is written up with provider / expected / actual
- [ ] A recommendation is recorded, including "not worth doing" with its reasoning
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0
- [ ] `git diff --stat -- packages/payment/src` is empty
- [ ] `plans/README.md` row updated with the recommendation, not just a status

## 8. Risks & STOP conditions

- **STOP** after artefact 1 if fewer than about five assertions are genuinely shared.
  Then there is no suite to build, and the honest answer is `describe.each` for the
  handful — or nothing. Write that up and finish.
- **STOP** if WS2's proof of concept fails for a provider. Report the divergence; do
  not fix it inside a spike.
- **STOP** if building the proof of concept requires changing `PaymentAdapter` or a
  provider's constructor to make it testable. A contract that cannot be exercised
  through its own interface is a much bigger finding than a missing suite — report it.
- **Risk:** a suite that only asserts method _shapes_ duplicates what TypeScript
  already guarantees and costs real maintenance. Artefact 2 is the guard against
  building that.
- **Risk:** scope creep into "let's also fix the providers we found". Six providers ×
  one divergence each is a quarter, not a spike.

## 9. Open questions

1. Is there any evidence of a payment adapter being written outside this repo? That is
   the single biggest input to `describe.each` vs published TCK.
2. Do the two `autumn` files (`autumn.ts` and `autumn-features.ts`) count as one
   provider or two for suite purposes? It affects the parameterization.
3. Does `not-supported.ts` represent a seventh adapter that should also pass the suite,
   or a helper the others use? Read it; the answer shapes artefact 3.
