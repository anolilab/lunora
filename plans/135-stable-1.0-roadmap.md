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

| Tier                    | Packages                                                                                                                                                                                                                                                                                                | 1.0 treatment                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Core (stable 1.0)**   | `server`, `values`, `errors`, `runtime`, `do`, `client`, `codegen`, `cli`, `vite`, `config`, `d1`, `react`, `testing`, `lunorash` umbrella                                                                                                                                                              | Full SemVer commitment, API-guarded                                                             |
| **Stable adapters**     | `vue`, `solid`, `svelte`, `astro`, `nuxt`, `auth`, `storage`, `scheduler`, `mail`, `ratelimit`, `seed`, `db`, `sql-store` (internal), `studio`, `advisor`, `mcp`, `bindings`, `hyperdrive`, `cloudflare-access`, `queue`, `workflow`, `flags`, `fingerprint`, `dispatch` (private)                      | 1.0 if they pass the same gates; any that don't, hold at `0.x`/`-beta`                          |
| **Experimental at 1.0** | `agent` (alpha.1, deliberately unsettled per plan 113), `replica` (alpha.2, 8 tests / 23 src files), `x402` (alpha.2, unverified on workerd, CDP-Solana `NOT_IMPLEMENTED`), `react-native` (alpha.2, 226 LoC), `angular` (alpha.8, no framework docs), `ai`, `browser`, `container`, `payment` (assess) | Publish as `1.0.0-beta.*` or `0.x`, tagged experimental in docs; NOT part of the stable promise |

Deliverables:

- [ ] Ratify the tier table (maintainer decision).
- [x] Annotate experimental surfaces with `@experimental` JSDoc systematically
      (today only 4 stability tags exist across the entire repo).
      _Done 2026-07-16: every export reachable from the nine experimental-tier
      packages' entry points tagged (~550 declarations) + README notices; the
      plan-052 HTTP-SSE stream surface tagged across server/client/react/codegen._
- [ ] Publish the tiering as a docs page ("stability & versioning policy").

## Phase 1 — Verification backbone (highest-leverage work)

The largest hole: **the real Cloudflare runtime is never exercised on a merge
gate.** 10 workerd integration suites exist across `runtime`, `scheduler`,
`d1`, `storage`, `client`, `do` (`__tests__/workerd/*`) but are gated behind
`LUNORA_WORKERD_TESTS=1`, which CI never sets (`.github/workflows/test.yml`
lines 89–100; plan 122 is BLOCKED because the pool won't boot in the dev
sandbox — GitHub-hosted runners are unaffected by that sandbox limitation).

- [x] **Unblock plan 122**: add a dedicated `workerd-integration` CI job
      (coverage off — v8/`node:inspector` is unsupported in pool-workers; plain
      `vitest run` with `LUNORA_WORKERD_TESTS=1`). Make it a required check.
      _Done 2026-07-16: `test-workerd` job in `test.yml` (6-package matrix,
      `--project workerd`, no coverage) wired into `test-required-check`;
      runtime verification comes from the first CI run on GitHub._
- [x] Extend workerd smoke to packages that ship DO/worker code but have no
      workerd suite today (`queue`, `workflow`, `container`, `x402` boot-smoke).
      _Done 2026-07-16: `LUNORA_WORKERD_TESTS=1`-gated `workerd` vitest projects + `__tests__/workerd/` suites for all four (queue: real producer →
      `queue()` consumer end-to-end; workflow: `LunoraWorkflow` entrypoint runs
      to completion on the real engine; container: DO boots to the documented
      no-Docker guard + bridge RPC round-trip; x402: `withX402` + procedure gate
      402-challenge with the facilitator mocked at the fetch boundary); all four
      added to the `test-workerd` matrix in `test.yml` + `nightly.yml`._
- [x] **Coverage thresholds**: add vitest `coverage.thresholds` to the shared
      config (`tools/get-vitest-config.ts`) — start at current levels per
      package, ratchet up; flip Codecov `patch` coverage from `"off"` to a
      real target so new code can't land untested (`codecov.yml`).
      _Done 2026-07-16: default floor 80% lines/statements/functions + 70%
      branches in `getVitestConfig` (per-package override param; 12 packages
      below the floor carry explicit `// ratchet:` overrides; workerd-gated
      inline configs stay threshold-free); Codecov patch gate on at 75%,
      `informational: false`._
- [x] **Close the worst unit-coverage gaps** — DONE (2026-07-16): `lunorash`
      14→100 tests (exports-map manifest, surface pins, bin), `errors` 25→180
      (catalog integrity + exhaustive `toErrorBody` redaction sweeps),
      `fingerprint` 19→41, `dispatch` 8→22, `ai` 68→89 (rag primitives),
      `replica` 157→223 (real sql.js/better-sqlite3 adapters, DO client wire),
      `db` 45→55 — which surfaced and fixed a real bug: the unified outbox
      silently dropped raw offline `client.mutation` writes (empty
      transactions short-circuit; now carried by an internal transport-carrier
      collection).
- [x] **Nightly full-matrix run**: `vis affected` on PRs is fine, but add a
      scheduled workflow running the FULL test suite (all packages, workerd job,
      e2e un-skipped) so unchanged packages still get re-verified.
      _Done 2026-07-16: `.github/workflows/nightly.yml` — 03:00 UTC cron +
      `workflow_dispatch`; full `pnpm run test` on node 22/24, the workerd
      matrix, and e2e unconditionally; not a required check._
- [x] **De-flake and expand e2e**: remove the standing `CI_E2E_SKIP` /
      `LUNORA_E2E=skip` escape hatch (fix root causes; Playwright `retries: 2`
      stays), and grow past the 7 chat-app specs — at minimum: sharding
      failover, offline queue replay, auth+RLS end-to-end, `lunora init`
      scaffold-install-deploy smoke against a packed tarball.
      _Done 2026-07-16: escape hatch removed (test.yml + config); boot de-flaked
      (180s budget, captured child output, port pre-flight, process-group
      teardown, firefox-if-installed); +4 specs — offline replay ordering,
      auth+RLS over live WS (new `notes` RLS surface in the playground),
      same-shard convergence, `lunora init → codegen → tsc` smoke via the built
      CLI (`--from templates`; registry install/deploy stays in
      `scripts/clean-machine-smoke.sh`); 3 consecutive green full runs._
- [x] Fix or quarantine the Studio jsdom component-test hang so those 90+ tests
      run in CI (dedicated job acceptable).
      _Done 2026-07-16: the hang was an unbounded render loop in the SQL-editor
      autocomplete (fixed in `fix(studio)`, plus a bare-`<Studio>` theme-context
      crash and a global-browser selection race); the rotted tests were repaired
      (URL-controlled DataBrowser harness, async live-push waits, stale
      fixtures). Full suite green: 91 files / 734 tests in ~60s. CI: a "Run
      studio tests" step in test.yml runs unit + component on both node legs,
      and the nightly/root `test` scripts no longer exclude studio. Nothing
      quarantined; studio stays excluded from the COVERAGE scripts only (a
      component run under v8 coverage still stalls — see
      `packages/studio/vitest.config.ts`)._
- [x] Write the deferred real-binding tests: Hyperdrive round-trip
      (`packages/hyperdrive/__tests__/create-hyperdrive.test.ts:138` `it.todo`).
      _Done 2026-07-16: CI-gated suite drives the real `postgres`/`pg`/`mysql2`
      drivers through an `env.HYPERDRIVE`-shaped binding over real wire protocols
      (pglite behind `@electric-sql/pglite-socket`; mysql-memory-server, auto-
      skipping with reason where the binary download is blocked)._
- [x] **Dependency hygiene**: triage the open Dependabot alerts on the default
      branch (13 at 2026-07-16: 4 high / 7 moderate / 2 low) — resolve or
      formally dismiss each before the stable cut, and keep Renovate green.
      _Done 2026-07-16 (see "Dependency triage (2026-07-16)" below): all 13
      resolved by an in-range refresh of `.deepsec/pnpm-lock.yaml`; the main
      workspace lockfile audits clean. Caveat: triage worked from `pnpm audit`
      (npm advisory DB), which may not match the GitHub Dependabot list 1:1 —
      a maintainer must cross-check the alerts page and dismiss/confirm there._

## Dependency triage (2026-07-16)

Where the alerts actually live: the **main workspace lockfile
(`pnpm-lock.yaml`) audits clean** — verified twice, via `pnpm audit`
(0 advisories, dev + prod) and via a direct bulk query of all 3,556 resolved
versions against the npm advisory DB. The 13 findings (4 high / 7 moderate /
2 low — the same severity split GitHub reports) all sit in
**`.deepsec/pnpm-lock.yaml`**, the standalone deepsec scanning workspace,
under its single dependency `deepsec@2.0.12`. Nothing shipped by any
`@lunora/*` / `lunorash` package was affected.

Fix applied: all three vulnerable packages had patched releases inside the
ranges already declared by their dependents (`tar ^7.5.13`, `hono ^4.11.4`
via `@modelcontextprotocol/sdk`, `undici ^7.16.0` via `@vercel/sandbox`), so
no catalog change and no `pnpm.overrides` entry was needed — a targeted
transitive refresh (`pnpm update --depth Infinity tar hono undici` in
`.deepsec/`) resolved everything: `tar` 7.5.15 → 7.5.20, `hono` 4.12.23 →
4.12.30, `undici` 7.26.0 → 7.28.0. `pnpm audit` in `.deepsec/` is now clean;
`deepsec` stays pinned at 2.0.12 (2.2.1 exists — separate, deliberate bump).

| Advisory            | Severity | Package (found → fixed) | Path                                                   | Action taken                         | Residual risk                                                       |
| ------------------- | -------- | ----------------------- | ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| GHSA-88fw-hqm2-52qc | high     | hono 4.12.23 → 4.12.30  | .deepsec > deepsec > claude-agent-sdk > MCP SDK > hono | in-range lockfile refresh (≥4.12.25) | none — dev-only scanning workspace, never deployed                  |
| GHSA-wwfh-h76j-fc44 | moderate | hono 4.12.23 → 4.12.30  | same as above                                          | same refresh                         | none (Windows serve-static path traversal; unused code path anyway) |
| GHSA-j6c9-x7qj-28xf | moderate | hono 4.12.23 → 4.12.30  | same as above                                          | same refresh                         | none (AWS Lambda adapter; not used)                                 |
| GHSA-rv63-4mwf-qqc2 | moderate | hono 4.12.23 → 4.12.30  | same as above                                          | same refresh                         | none (AWS Lambda body-limit bypass; not used)                       |
| GHSA-wgpf-jwqj-8h8p | moderate | hono 4.12.23 → 4.12.30  | same as above                                          | same refresh                         | none (Lambda@Edge adapter; not used)                                |
| GHSA-vmh5-mc38-953g | high     | undici 7.26.0 → 7.28.0  | .deepsec > deepsec > @vercel/sandbox > undici          | in-range lockfile refresh (≥7.28.0)  | none — dev-only scanning workspace                                  |
| GHSA-vxpw-j846-p89q | high     | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (WS fragment-count DoS)                                        |
| GHSA-hm92-r4w5-c3mj | high     | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (SOCKS5 pool reuse; no SOCKS5 proxy in use)                    |
| GHSA-p88m-4jfj-68fv | moderate | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (Set-Cookie header injection)                                  |
| GHSA-pr7r-676h-xcf6 | moderate | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (shared-cache info disclosure)                                 |
| GHSA-35p6-xmwp-9g52 | low      | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (response-queue poisoning)                                     |
| GHSA-g8m3-5g58-fq7m | low      | undici 7.26.0 → 7.28.0  | same as above                                          | same refresh                         | none (SameSite downgrade)                                           |
| GHSA-vmf3-w455-68vh | moderate | tar 7.5.15 → 7.5.20     | .deepsec > deepsec > tar                               | in-range lockfile refresh (≥7.5.16)  | none (tar parser differential / file smuggling)                     |

Verification: root `pnpm install --frozen-lockfile` clean (root lockfile
untouched), `pnpm run build:packages` green, `.deepsec` reinstalls frozen and
`deepsec --version` still runs (2.0.12); no `@lunora/*` package's dependency
graph changed, so no per-package test/lint reruns were required. Pre-existing
(not introduced): the `.deepsec` zod@3.24.4 peer-range warning. Follow-ups
for a maintainer: (1) cross-check + close the alerts on the GitHub
Dependabot page — this triage worked from the npm advisory DB, which may not
be a 1:1 mirror; (2) optionally bump `deepsec` 2.0.12 → 2.2.1; (3) template
manifests (`templates/*/package.json`) carry no lockfiles and audited clean
by count-match, but Renovate should keep them fresh.

## Phase 2 — Close runtime gaps and the open security item

Nothing tagged stable may throw on an advertised path.

- [x] **Ship plan 095 (SECURITY, P2)** — SHIPPED (2026-07-16, all 3 phases):
      the worker mints a 60s HMAC-signed ephemeral token
      (`POST /_lunora/admin/ws-token`, master-bearer/adminGate-gated); the
      client accepts an async `WsTokenProvider` re-resolved per (re)connect;
      Studio mints via header auth with caching/early-refresh/fallback; opt-in
      enforcement (`requireEphemeralWsToken` /
      `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN`) rejects the raw master token in
      `?token=`. Plan file removed (shipped).
- [x] **Ship plan 090** — SHIPPED (2026-07-16): cache keys ride
      `stableWireKey` (`shared/wire-key.ts`, identity for pure JSON),
      subscribe/shape frames `encodeWire` their args, and the shard decodes at
      its two subscribe entry points, so `bigint` / `Date` / `Map` / `Set` /
      bytes args work end-to-end (`RegExp`/class instances still fail loud;
      `URL` args can't survive the hibernation attachment). Verified through a
      real workerd round-trip. Plan file removed (shipped).
- [x] **`mode: "incremental"` on tables** — CUT from the 1.0 surface
      (2026-07-16): `ExternalSourceMode` narrowed to `"full-pull"` so typed
      callers get a compile-time error instead of a runtime throw; the
      discovery/advisor seam is kept for the post-1.0 return, scoped in
      `plans/136-incremental-table-mode.md` (P3, demand-gated).
- [x] **Plan 052** — SHIPPED (2026-07-16): codegen emits a typed
      `httpStreams.*` registry (`HttpStreamRef<Chunk, SearchParams, Params>`
      with the `.stream()` handler's yielded chunk type inferred),
      `client.httpStream()` consumes the SSE framing with coded errors +
      abort/cancel, and React ships `useHttpStream`. Vue/Solid/Svelte ports and
      reconnect/POST-body/OpenAPI follow-ups are recorded in
      `plans/052-streaming-hook-design.md`.
- [x] **Next.js template** — SHIPPED (2026-07-16): `templates/next/` (App
      Router on the OpenNext Cloudflare adapter, two-worker split like nuxt,
      RSC preload via `@lunora/react/server` + `usePreloadedQuery` hydration);
      `lunora init -t next` guard dropped, picker/help/docs updated, scaffold
      covered in init tests + template validation manifests.
- [x] Sweep `@deprecated` remnants — DONE (2026-07-16): removed the ratelimit
      `random` shard-selection hook and the runtime `authIntrospector` worker
      option (superseded by `WorkerOptions.authAdmin`); tests migrated to the
      superseding paths.
- [x] Migration scaffold `TODO_table` placeholder UX — DONE (2026-07-16):
      `migrate create` now prompts for the table interactively (schema-derived
      choices via the new `promptText`/`promptSelect` helpers in
      `@lunora/config`) and fails with a clear error non-interactively.

## Phase 3 — API-stability guarantees & promotion mechanics

- [x] **Public-API snapshot guard**: no api-extractor/API-report tooling exists
      today. Add per-package public-API snapshot tests (api-extractor, or a
      lightweight `.d.ts` rollup snapshot in `__tests__`) for every Tier-1/2
      package, wired as a CI gate — a breaking change must fail a check, not a
      reviewer's memory.
      _Done 2026-07-16: `scripts/api-snapshot.js` extracts each Tier-1/2
      package's per-subpath export surface (name + kind + comment-stripped
      signature; sibling/third-party re-exports pinned by name only,
      `@experimental` exports excluded from signature tracking) from the built
      dist `.d.ts` into committed `api-snapshots/*.api.md`. `pnpm run api:check`
      diffs it (gated by the `Lint / api-surface` CI job); `pnpm run api:update`
      regenerates._
- [x] **Fix exact-alpha sibling peers** (direct 1.0 blocker — these break the
      moment a sibling promotes): `cloudflare-access`, `replica`, `seed` pin
      `@lunora/server@1.0.0-alpha.24` (seed also `values@1.0.0-alpha.7`);
      `config` and `vite` pin `@lunora/studio@1.0.0-alpha.50`. Re-pin to ranges
      that survive promotion (e.g. `>=1.0.0-alpha.24 <2`) and add a repo check
      (extend `scripts/check-cerebro-peer-lockstep.js` or a new script) so an
      exact sibling pin can't reappear.
      **Done**: all 6 pins re-pinned to `>=<floor> <2.0.0-0` ranges,
      `.multi-releaserc.json` sets `deps.bump: "satisfy"` (the default
      `"override"` was the clobberer — it rewrote replica's original range to an
      exact pin on release), and `scripts/check-sibling-peer-ranges.js` guards
      both in `postinstall`.
- [x] **Rehearse the release train**: dry-run multi-semantic-release for the
      `main` merge (all ~46 publishable packages promoting together), including
      the `lunorash` umbrella whose deps must resolve to the stable versions.
      **Done (2026-07-17, sandbox rehearsal — see `plans/137`)**: local-`main`
      dry run computed `1.0.0` on the default channel for all 46 packages
      (incl. `lunorash`; exact dep pins rewrite to `1.0.0`, peer ranges
      survive `deps.bump: "satisfy"`). _Caveat_: `verifyConditions` needs real
      tokens even under `--dry-run`, so a maintainer should repeat the dry run
      with real read-scoped tokens through the shipped config (runbook §4.4);
      note `origin/main`'s workflow still gates out stable releases and
      `main`/`alpha` have diverged — the merge must keep alpha's workflow.
- [x] Verify `lunora init` version-rewrite injects the stable dist-tag once
      `latest` exists (`packages/cli/src/commands/init/handler.ts:252,424`) —
      templates ship `^0.0.0` placeholders by design.
      **Done (2026-07-17)**: logic already correct — stable CLI derives
      dist-tag `latest` + template ref `main` (`src/util/source-ref.ts`); no
      hardcoded `alpha` outside the unpublished-`0.0.0` fallback. Now covered
      by unit tests (`resolveDistTag` per-version + init-level stable-pin
      test). _Caveat_: live `npx lunora@latest init` against the real
      registry remains a post-release check (Phase 5 step 5).
- [x] Confirm npm `latest` dist-tag semantics for first stable publish of each
      package (provenance/OIDC already configured).
      **Done (2026-07-17)**: preset `with-pnpm.json` makes `main` a plain
      release branch (default channel) and `@anolilab/semantic-release-pnpm`
      maps the default channel → `latest` (`getChannel`); `alpha` keeps its
      `alpha` dist-tag. Dry run confirmed 46× "default channel". _Caveat_:
      `npm dist-tag ls` end-state only observable after the real publish.

## Phase 4 — Docs & onboarding completeness

- [x] **Wire the 7 orphaned package docs into the site nav**: `agent`,
      `angular`, `cloudflare-access`, `errors`, `flags`, `nuxt`, `replica` have
      authored `docs/` that never surface because they're missing from
      `CATEGORY_CONFIG` in `apps/docs/scripts/copy-package-docs.js` (+
      `generate-packages.js` / `packages-metadata.json`). Consider generating
      the nav from the filesystem so this class of bug can't recur.
      _Done: nav now derived from `project.json` `category:*` tags via a shared
      `scripts/package-categories.js` (both scripts), so a docful package can't
      be orphaned again; all seven surface + curated metadata added._
- [x] Author docs for the 3 packages with none: `fingerprint`, `sql-store`
      (internal — a short "don't depend on this" page), `x402`.
      _Done: `docs/index.mdx` authored for all three (hash contract / both
      x402 rails + custody & spend policy / internal-notice) — auto-wired into
      the nav by the tag-derived sidebar._
- [x] Add `frameworks/angular.mdx` and `frameworks/nuxt.mdx` guides (packages
      ship, guides don't).
      _Done: both guides added (mirroring vue/astro), registered in the docs
      meta.json, and vue.mdx's stale "no single-worker Nuxt" caveat replaced._
- [x] **Write the 1.0 trio** — DONE (2026-07-16): `docs/versioning.mdx`
      (channels + provisional Phase-0 tier table), `docs/migrating/from-alpha.mdx`
      (living upgrade guide over the landed breaking changes), and
      `docs/production-checklist.mdx` (bindings, secrets, admin/WS tokens,
      ratelimit, RLS, migrations, observability, limits, advisors), all in the nav.
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
