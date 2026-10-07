# Plan 463 — Graduate the experimental tier to stable

**Baseline:** `f65dd4fbd` (2026-10-06)
**Status:** IN PROGRESS (A shipped in #1002; B1 `payment` graduated in #1001; B3 `x402` + `browser` graduated in code, pending maintainer sign-off on bar item 5)

## 0. Headline finding

Two different things were called "experimental". Untracked `@experimental` exports inside
**Core / Stable-adapter** packages (HTTP-SSE streams, the auth DO adapter + SSO, D1 retry,
Artifacts event types) were silent holes in the 1.0 SemVer promise: `api:check` skips a tagged
export's signature. They are cleared by part A. The twelve **experimental-tier packages** are a
separate, post-1.0 track gated by the six-point bar in `ROADMAP.md`.

## 1. Current state (audit)

Untracked exports per experimental package (`grep -c "signature not tracked" api-snapshots/<pkg>.api.md`)
and whether the package has a `LUNORA_WORKERD_TESTS` vitest project:

| Package          | Tagged exports | workerd suite            | Notes                                                                    |
| ---------------- | -------------- | ------------------------ | ------------------------------------------------------------------------ |
| `agent`          | 183            | no                       | largest surface; needs workerd before anything else                      |
| `x402`           | 0 (graduated)  | yes                      | B3: 13 internals un-exported, the rest tracked                           |
| `angular`        | 80             | n/a (browser)            |                                                                          |
| `replica`        | 69             | no                       |                                                                          |
| `ai`             | 63             | no                       |                                                                          |
| `browser`        | 0 (graduated)  | yes (fake binding)       | B3: all kept; stops at the DevTools upgrade (no local Chrome)            |
| `react-native`   | 5              | n/a (device)             | the rest re-exports `@lunora/react`, now tracked                         |
| `container`      | 0              | yes (partial: no Docker) | fully tracked already                                                    |
| `platform-celld` | 0              | n/a (`test:celld` TCK)   | service deploy run with `--dry-run` only; needs a real fleet (S3) deploy |
| `platform-node`  | 0              | n/a (Node host)          |                                                                          |
| `rspack`         | 0              | n/a (bundler)            |                                                                          |

## 2. Existing seams (do not reinvent)

- `scripts/api-snapshot.js` — tiers (`TIER_1/2/3`) and `FULLY_TRACKED_SNAPSHOTS`, which fails
  `api:check` when a listed snapshot has an untracked export.
- `scripts/check-roadmap-tiers.js` — asserts `ROADMAP.md` and the tier lists agree.
- `LUNORA_WORKERD_TESTS`-gated vitest projects + `pnpm run test:workerd`.

## 3. The behavioural contract to preserve

Graduating a package moves it from `TIER_3` to `TIER_2`, which adds it to
`FULLY_TRACKED_SNAPSHOTS`; from then on every export signature is gated and SemVer applies.

## 5. Parts

**A — stable-tier tags (DONE).** Dropped `@experimental` from the 39 exports in `client`,
`react`, `server`, `lunorash`, `auth`, `d1`, `bindings`; all Core + Stable snapshots joined
`FULLY_TRACKED_SNAPSHOTS` so a tag cannot creep back. `legacyIssuerCleanupStatements` stays: it
is a documented one-shot migration for databases created by older `@lunora/auth`, not a shim.
Open questions the tags used to defer (SSE reconnect / POST body, plans 052 / 033) must land as
additive options from here on.

**B — per package, in this order** (each graduates independently when all six bar items hold):

1. `payment` — DONE in #1001: full audit, thermos review, workerd suite over the real store,
   tags dropped, moved to `TIER_2`.
2. `container` — already fully tracked; finish lifecycle/`exec` verification (needs Docker in CI).
3. `x402`, `browser` — DONE for code, pending maintainer sign-off on bar item 5: tags triaged, both moved to `TIER_2`. `x402` kept every export
   except 13 rail internals (`createPayFetch`, `registerWallet`, `resolveEvmAccount`,
   `resolveSvmSigner`, `buildSpendPolicy`, `buildPaymentGuard`, `releaseSpendOnFailure`,
   `assertBoundedPolicy`, `createSpendState`, `SpendState`, `WalletDeps`,
   `createFacilitatorClient`, `toReceipt`), which would have put `@x402/core`'s hook types under
   SemVer; its workerd suite now pays a 402 end to end (viem signature inside workerd, facilitator
   faked). `browser` kept all 25 and exports the four types its surface already referenced; its
   new workerd suite runs the real `@cloudflare/playwright` peer against a fake Browser Run
   service binding up to the DevTools upgrade. Bar item 5 (used in anger outside this repo) is a
   maintainer sign-off for both.
4. `ai`, `agent`, `replica` — add workerd suites first (bar item 2), then triage.
5. `angular`, `react-native`, `rspack`, `platform-*` — not workerd-bound; bar items 1, 3–6 only.

For each: drop the remaining tags (or list the frozen exceptions), move the dir from `TIER_3` to
`TIER_2`, update `ROADMAP.md` + `apps/docs/.../versioning.mdx`, `pnpm run api:update`.

## 6. Verification

`pnpm run api:check` (fails on any tag in a fully-tracked snapshot), `pnpm run test:workerd`,
`node scripts/check-roadmap-tiers.js`.
