# Plan 135 — Road to stable 1.0.0

- **Category**: direction (user-requested)
- **Priority**: P1
- **Status**: TODO
- **Baseline**: `f12386e` (2026-07-16), all 47 packages at `1.0.0-alpha.*`
- **Goal**: define and execute the path from today's alpha channel to a
  coordinated, SemVer-committed stable `1.0.0` on `main`.

This plan is the umbrella roadmap. Individual work items should be executed as
their own plans/PRs; this file tracks the phases and the exit criteria. Sources:
a 2026-07-16 three-track audit (code gaps, test/CI health, docs/release
readiness) over the whole repo.

---

## What "stable" means here

1. **The deploy target is verified in CI.** The workerd/Cloudflare runtime path
   — the product's entire point — runs on a merge gate, not only on developer
   workstations.
2. **No advertised feature throws `NOT_IMPLEMENTED` or is half-wired**, unless
   it is explicitly tagged experimental and excluded from the SemVer surface.
3. **The public API surface is enumerated and machine-guarded** so a breaking
   change cannot ship as a patch.
4. **Promotion is mechanically safe**: peer ranges, templates, and the release
   train all survive `1.0.0-alpha.N → 1.0.0` without manual heroics.
5. **A user can onboard, deploy, and upgrade from docs alone.**

## Current state snapshot (2026-07-16)

- 47 packages, all `1.0.0-alpha.*` (cli at `alpha.86`, agent/dispatch/fingerprint
  at `alpha.1`, react-native/replica/x402 at `alpha.2`).
- Release pipeline is ready: `main → latest` is already wired via
  `@anolilab/semantic-release-preset` + multi-semantic-release
  (`.github/workflows/semantic-release.yml`). Promotion is a semantics problem,
  not a pipeline problem.
- CI runs affected-only unit tests on Linux (node 22.15 + 24.11); workerd
  integration suites, Studio jsdom component tests, and the playground are all
  excluded; e2e is narrow (7 specs) and skippable via `CI_E2E_SKIP`.
- Only two open GitHub issues (one design record, one Renovate dashboard) — the
  real backlog lives in `plans/` and in the gaps below.

---

## Phase 0 — Decide the stable surface (scope cut)

The single most important decision: **not everything ships as stable 1.0.**
Trying to stabilize 47 packages at once guarantees either delay or a hollow
promise. Proposed tiering (to be ratified by the maintainer):

| Tier | Packages | 1.0 treatment |
| ---- | -------- | ------------- |
| **Core (stable 1.0)** | `server`, `values`, `errors`, `runtime`, `do`, `client`, `codegen`, `cli`, `vite`, `config`, `d1`, `react`, `testing`, `lunorash` umbrella | Full SemVer commitment, API-guarded |
| **Stable adapters** | `vue`, `solid`, `svelte`, `astro`, `nuxt`, `auth`, `storage`, `scheduler`, `mail`, `ratelimit`, `seed`, `db`, `sql-store` (internal), `studio`, `advisor`, `mcp`, `bindings`, `hyperdrive`, `cloudflare-access`, `queue`, `workflow`, `flags`, `fingerprint`, `dispatch` (private) | 1.0 if they pass the same gates; any that don't, hold at `0.x`/`-beta` |
| **Experimental at 1.0** | `agent` (alpha.1, deliberately unsettled per plan 113), `replica` (alpha.2, 8 tests / 23 src files), `x402` (alpha.2, unverified on workerd, CDP-Solana `NOT_IMPLEMENTED`), `react-native` (alpha.2, 226 LoC), `angular` (alpha.8, no framework docs), `ai`, `browser`, `container`, `payment` (assess) | Publish as `1.0.0-beta.*` or `0.x`, tagged experimental in docs; NOT part of the stable promise |

Deliverables:

- [ ] Ratify the tier table (maintainer decision).
- [ ] Annotate experimental surfaces with `@experimental` JSDoc systematically
      (today only 4 stability tags exist across the entire repo).
- [ ] Publish the tiering as a docs page ("stability & versioning policy").

## Phase 1 — Verification backbone (highest-leverage work)

The largest hole: **the real Cloudflare runtime is never exercised on a merge
gate.** 10 workerd integration suites exist across `runtime`, `scheduler`,
`d1`, `storage`, `client`, `do` (`__tests__/workerd/*`) but are gated behind
`LUNORA_WORKERD_TESTS=1`, which CI never sets (`.github/workflows/test.yml`
lines 89–100; plan 122 is BLOCKED because the pool won't boot in the dev
sandbox — GitHub-hosted runners are unaffected by that sandbox limitation).

- [ ] **Unblock plan 122**: add a dedicated `workerd-integration` CI job
      (coverage off — v8/`node:inspector` is unsupported in pool-workers; plain
      `vitest run` with `LUNORA_WORKERD_TESTS=1`). Make it a required check.
- [ ] Extend workerd smoke to packages that ship DO/worker code but have no
      workerd suite today (`queue`, `workflow`, `container`, `x402` boot-smoke).
- [ ] **Coverage thresholds**: add vitest `coverage.thresholds` to the shared
      config (`tools/get-vitest-config.ts`) — start at current levels per
      package, ratchet up; flip Codecov `patch` coverage from `"off"` to a
      real target so new code can't land untested (`codecov.yml`).
- [ ] **Close the worst unit-coverage gaps** (test files vs src files):
      `lunorash` umbrella (1 test / 22 src — it IS the recommended install),
      `errors` (1/6, everything depends on it), `fingerprint` (1/4),
      `dispatch` (1/4), `ai` (3/11), `replica` (8/23), `db` (4/7).
- [ ] **Nightly full-matrix run**: `vis affected` on PRs is fine, but add a
      scheduled workflow running the FULL test suite (all packages, workerd job,
      e2e un-skipped) so unchanged packages still get re-verified.
- [ ] **De-flake and expand e2e**: remove the standing `CI_E2E_SKIP` /
      `LUNORA_E2E=skip` escape hatch (fix root causes; Playwright `retries: 2`
      stays), and grow past the 7 chat-app specs — at minimum: sharding
      failover, offline queue replay, auth+RLS end-to-end, `lunora init`
      scaffold-install-deploy smoke against a packed tarball.
- [ ] Fix or quarantine the Studio jsdom component-test hang so those 90+ tests
      run in CI (dedicated job acceptable).
- [ ] Write the deferred real-binding tests: Hyperdrive round-trip
      (`packages/hyperdrive/__tests__/create-hyperdrive.test.ts:138` `it.todo`).

## Phase 2 — Close runtime gaps and the open security item

Nothing tagged stable may throw on an advertised path.

- [ ] **Ship plan 095 (SECURITY, P2)**: ephemeral WS admin token — today the
      master `LUNORA_ADMIN_TOKEN` travels in the WebSocket URL query string
      (logged/cached). This is the only open security-audit finding and must
      land before any stable cut.
- [ ] **Ship plan 090**: subscription/cache-key arg wire fidelity — `bigint` /
      `Date` / `Map` / `Set` / `URL` / bytes args currently fail loud in
      `stableStringify` on the reactive hot path. Implement, or document the
      supported arg domain and keep the loud failure as the contract.
- [ ] **`mode: "incremental"` on tables** (`packages/server/src/schema.ts:672`,
      throws today): implement, or cut from the 1.0 surface (remove from
      types/docs, keep as post-1.0 plan).
- [ ] **Plan 052**: typed SSE consumer for `httpRoute.<verb>().stream()` —
      finish the client half or de-advertise `.stream()` for 1.0.
- [ ] **Next.js template**: `lunora init -t next` errors "not yet available"
      (`packages/cli/src/commands/init/handler.ts:1375`). Ship `templates/next`
      (spike done, plan 110) or drop the option from help/docs until it exists.
- [ ] Sweep `@deprecated` remnants before the API freeze: ratelimit
      shard-selection option (`rate-limiter.ts:26`), runtime `authAdmin`
      worker option (`create-worker.ts:556`) — remove in the last alpha, since
      1.0 is the free breaking-change moment.
- [ ] Migration scaffold `TODO_table` placeholder UX
      (`packages/cli/src/commands/migrate/handler.ts:285`) — prompt for the
      table instead (small, but it's first-run UX).

## Phase 3 — API-stability guarantees & promotion mechanics

- [ ] **Public-API snapshot guard**: no api-extractor/API-report tooling exists
      today. Add per-package public-API snapshot tests (api-extractor, or a
      lightweight `.d.ts` rollup snapshot in `__tests__`) for every Tier-1/2
      package, wired as a CI gate — a breaking change must fail a check, not a
      reviewer's memory.
- [ ] **Fix exact-alpha sibling peers** (direct 1.0 blocker — these break the
      moment a sibling promotes): `cloudflare-access`, `replica`, `seed` pin
      `@lunora/server@1.0.0-alpha.24` (seed also `values@1.0.0-alpha.7`);
      `config` and `vite` pin `@lunora/studio@1.0.0-alpha.50`. Re-pin to ranges
      that survive promotion (e.g. `>=1.0.0-alpha.24 <2`) and add a repo check
      (extend `scripts/check-cerebro-peer-lockstep.js` or a new script) so an
      exact sibling pin can't reappear.
- [ ] **Rehearse the release train**: dry-run multi-semantic-release for the
      `main` merge (all ~46 publishable packages promoting together), including
      the `lunorash` umbrella whose deps must resolve to the stable versions.
- [ ] Verify `lunora init` version-rewrite injects the stable dist-tag once
      `latest` exists (`packages/cli/src/commands/init/handler.ts:252,424`) —
      templates ship `^0.0.0` placeholders by design.
- [ ] Confirm npm `latest` dist-tag semantics for first stable publish of each
      package (provenance/OIDC already configured).

## Phase 4 — Docs & onboarding completeness

- [ ] **Wire the 7 orphaned package docs into the site nav**: `agent`,
      `angular`, `cloudflare-access`, `errors`, `flags`, `nuxt`, `replica` have
      authored `docs/` that never surface because they're missing from
      `CATEGORY_CONFIG` in `apps/docs/scripts/copy-package-docs.js` (+
      `generate-packages.js` / `packages-metadata.json`). Consider generating
      the nav from the filesystem so this class of bug can't recur.
- [ ] Author docs for the 3 packages with none: `fingerprint`, `sql-store`
      (internal — a short "don't depend on this" page), `x402`.
- [ ] Add `frameworks/angular.mdx` and `frameworks/nuxt.mdx` guides (packages
      ship, guides don't).
- [ ] **Write the 1.0 trio**: versioning/stability policy page (the Phase-0
      tier table), alpha→1.0 upgrade guide, production-readiness checklist
      (bindings, secrets, limits, observability).
- [ ] Migration guides: `from-convex.mdx` exists; add at least a generic
      "from REST/Express" or "from Firebase" path if 1.0 marketing targets them.

## Phase 5 — Beta → RC → 1.0.0 train

Sequenced last; starts once Phases 1–3 are green.

1. [ ] **Feature freeze** on Tier-1/2 packages; merge `alpha → beta` (channel
       already wired). Experimental tier keeps iterating on alpha.
2. [ ] **Bake period (2–4 weeks)**: dogfood a real app (playground + at least
       one external/production-ish deployment) against the beta channel;
       bug-fix-only on beta.
3. [ ] RC on `next` if beta surfaces churn; otherwise straight to:
4. [ ] **Merge to `main`** → multi-semantic-release publishes stable `1.0.0`
       (with the coordinated peer re-pins from Phase 3 landing in the same
       train).
5. [ ] Post-release: verify `lunora init` end-to-end against npm `latest`,
       announce the stability tiers, open post-1.0 plans for the experimental
       tier's promotion criteria.

---

## Exit criteria (the 1.0 gate, all must hold)

- [ ] Workerd integration job is a required CI check and green.
- [ ] Codecov patch coverage gate on; per-package thresholds in vitest.
- [ ] e2e runs unconditionally in CI (no skip vars) and covers init→deploy.
- [ ] Zero `NOT_IMPLEMENTED`/throwing paths in Tier-1/2 advertised APIs.
- [ ] Plan 095 (WS admin token) shipped.
- [ ] Public-API snapshot gate live for all Tier-1/2 packages.
- [ ] No exact-version sibling peerDependencies anywhere.
- [ ] Versioning policy + upgrade guide + production checklist published.
- [ ] All authored package docs reachable in the site nav.
- [ ] Release-train dry run completed without manual intervention.

## Explicitly NOT blockers (audited, keep as-is)

- README coverage — every package has a real, purpose-appropriate README.
- Release pipeline branch config — `main → latest` already wired.
- `lunorash` naming wart (npm name vs `lunora` bin) — intentional, documented.
- Template `^0.0.0` placeholders — rewritten by `lunora init` at scaffold time
  (verify against stable tag in Phase 3, but the mechanism exists).
- `shard-do.ts` god-file split (TECH-01) — maintainability, not correctness;
  stays deferred.
- Plans 033/037/078/089/114/115/133 — deferred features/directions, none gate
  stability.
- Issue #75 (opt-in ordered mutation queue) — documented design boundary.
