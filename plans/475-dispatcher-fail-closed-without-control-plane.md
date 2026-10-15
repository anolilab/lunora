# Plan 475 — The dispatcher must fail closed when the control plane is not configured

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PARTIAL on `feat/cloud-dispatcher-fail-closed`. Workstreams A, B (test), D shipped; C not done. The PR #1122
review round is closed: one control-plane decision per request, one 503 refusal shape, a missing lineage secret counted
as a misconfiguration rather than `forged`, and the counter read back. Still open: the staging and production
`CONTROL_PLANE_URL` hosts (the user provides them), and the drill and counter check in C.

- **A shipped.** `LUNORA_ENVIRONMENT` is in all three `dispatcher.wrangler.jsonc` blocks. Outside `development`
  (absent or unrecognised counts as enforced) a request without a control plane gets 503 `control_plane_unconfigured`,
  `retry-after: 30`, logged once per isolate, counted in `PLATFORM_METRICS` (`control_plane_unconfigured` kind, `setting`
  `control_plane`) and read back by `GET /v1/platform/metrics` as `controlPlaneUnconfigured`. The gate runs before
  routing, so custom and redirect domains are refused too. Lineage follows §4.3: a header with no
  `LUNORA_LINEAGE_SECRET` outside `development` gets 503 `lineage_unverifiable`, `retry-after: 30`, counted with
  `setting` `lineage_secret` and logged once per isolate. It is not counted as `forged`, which stays for headers that
  fail verification. No header is unaffected.
- **B shipped and green.** `__tests__/dispatcher-config.test.ts` enforces the rules. The unsubstituted `<replace-…>`
  values are refused at deploy by `scripts/check-deploy-config.ts`; the unit test does not duplicate that check. No
  hostname was guessed. The only known production candidate is `https://cloud.lunora.app` (the control plane's OTLP
  endpoint in `wrangler.jsonc`), which is inferred, not confirmed. Substitute the real URLs before deploy.
- **D shipped.** The 503 body names the missing setting (URL, token, or both).
- **C not done.** It is an ops drill (staging drill, production counter check).
- Choices made: `development` is set only at the top level (`wrangler dev`), and the top-level `CONTROL_PLANE_URL`
  placeholder was dropped. Existing dispatcher test fixtures without a control plane now declare `development`.

## 0. Headline finding

When the dispatcher has no control-plane URL or token, it does not refuse anything. It serves every tenant
on the **free** tier. That includes suspended and over-cap organisations, protected previews, and any script
whose plan was never looked up. A misconfigured production or staging deploy therefore turns the spend cap,
the suspension and the preview gate into no-ops, silently. This is a money and access bypass caused by config
drift, not by an attacker.

Size: **H** (suspension and access enforcement). Small to fix.

## 1. Current state (audit)

- `apps/cloud/src/dispatcher/worker.ts:263-266` — `buildResolvers` clears `planResolver` and
  `customDomainResolver` when `CONTROL_PLANE_URL` or `CONTROL_PLANE_TOKEN` is missing.
- `apps/cloud/src/dispatcher/worker.ts:446-447` — `const plan = planResolver === undefined ? "free" : route.plan;`.
  A missing resolver is read as "the free tier applies", and `refusalFor("free")` (`worker.ts:399`) then admits
  the request.
- `apps/cloud/src/dispatcher/worker.ts:461` — the protected-preview gate runs only when the token exists
  (`route.protected === true && env.CONTROL_PLANE_TOKEN`), so a missing token also removes the preview password.
- `apps/cloud/src/dispatcher/worker.ts:291` — `redirectOnlyDomain` and the custom-domain resolver depend on the
  control plane. Without it, a suspended custom domain is served.
- `apps/cloud/dispatcher.wrangler.jsonc:36-37` — `LUNORA_LINEAGE_SECRET` absent means lineage is "inert": loop
  protection goes silent instead of refusing.
- `apps/cloud/dispatcher.wrangler.jsonc:38, 63, 81` — the config ships placeholder URLs: the top-level
  `CONTROL_PLANE_URL` is `https://lunora-cloud.example.workers.dev`, and the staging and production blocks carry
  the literal strings `<replace-with-staging-control-plane-url>` and `<replace-with-production-control-plane-url>`.
  A deploy that forgets to substitute them gets a non-empty URL that can never answer. Today that fails closed by
  accident (a fetch error becomes `unavailable`). It is not a guarantee.
- The comment at `worker.ts:446` says the free tier is for "local dev". Nothing in the config distinguishes local
  dev from a deployed environment, so the comment's premise is not enforced.

## 2. Existing seams (do not reinvent)

- `refusalFor` and `SERVABLE_PLANS` (`worker.ts:399`, `route.ts:99`) already define admission. Fail-closed is a new
  input to that function, not a new check.
- `UNAVAILABLE_PLAN` (`route.ts:109`) already means "refuse, retry later". Reuse it for "not configured" rather than
  inventing a second refusal shape.
- `dispatcher.wrangler.jsonc` has `production` and `staging` environment blocks that restate bindings (`:45-85`). A
  config test can read those blocks.

## 3. The behavioural contract to preserve

- A deployed dispatcher with a healthy control plane behaves exactly as today.
- Local development (`wrangler dev` of the dispatcher with no secrets) keeps working and still serves the free tier,
  but only when the environment says it is local.
- A suspended or over-cap tenant is refused in every configuration.

## 4. Design decisions

1. **Explicit environment, not an inferred one.** Add `LUNORA_ENVIRONMENT` (`production` | `staging` | `development`)
   as a `vars` entry in each environment block of `dispatcher.wrangler.jsonc`.
   _Rejected:_ detecting "local" from the hostname or `request.cf`. Both can be spoofed or change.
2. **Missing control plane = refuse, unless `development`.** In `production` and `staging`, a dispatcher without the
   resolver answers `503` with `retry-after: 30` and a stable error code (`control_plane_unconfigured`). It logs once
   per isolate and increments a `PLATFORM_METRICS` counter.
   _Rejected:_ keep serving at the free tier and alert. An alert arrives after the bypass has already served traffic.
3. **Lineage follows the same rule.** In `production` and `staging`, a missing `LUNORA_LINEAGE_SECRET` refuses requests
   that carry a lineage header and logs an error. Requests with no lineage header are unaffected, so the loop guard is
   restored without blocking ordinary traffic.
   _Rejected:_ refuse all traffic without the secret. That turns a secret typo into a full outage.

## 5. Workstreams

**A. Environment flag and resolver gate (S).** Add the variable to all three blocks. Replace the
`planResolver === undefined ? "free"` line with a branch on the environment. Cover it with a unit test per
environment and per missing-config case.

**B. Config conformance test (S).** A vitest case parses `dispatcher.wrangler.jsonc`, then asserts that each of
`production` and `staging` declares `LUNORA_ENVIRONMENT`, `CONTROL_PLANE_URL` and `LUNORA_APP_DOMAIN`, and that
`development` is the only environment allowed to omit them. The secrets (`CONTROL_PLANE_TOKEN`,
`LUNORA_LINEAGE_SECRET`) cannot be checked statically, so the runtime gate in A is their check. The test also rejects
any value that still starts with `<replace-` or is the `example.workers.dev` placeholder, in every environment, so an
unsubstituted template cannot be deployed as a control-plane URL.

**C. Staged rollout (S, ops).** Deploy to `staging` first, then run the drill in §7 Phase 2 before production.

**D. Operator message (S).** The 503 body names the missing setting in plain words ("control plane URL not set for this
environment"), so the operator who sees the failure knows the fix without reading this plan.

## 6. Platform parity

Not applicable. The dispatcher is a Lunora Cloud component, not a framework `ctx.*` surface or a provider binding, and the
framework matrix does not describe it.

## 7. Phasing & ordering

| Phase | Work                                                                                                                                                        | Gate                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Workstreams A, B and D, with unit and config tests                                                                                                          | `pnpm --filter @lunora/cloud run test` green, including a test that fails on the old `"free"` fallback (verify by reverting the line once) |
| 2     | Staging drill: remove `CONTROL_PLANE_URL` from a staging dispatcher version, confirm 503 for a tenant and for a suspended org, restore it, confirm recovery | Recorded drill output: refused while unconfigured, served after restore                                                                    |
| 3     | Production rollout and a check that no tenant was served while unconfigured (via the new counter)                                                           | Counter is zero for the deploy window                                                                                                      |

## 8. Risks & STOP conditions

- **STOP** if the staging drill shows a tenant served while the control plane is unconfigured. The design is wrong
  somewhere; re-scope rather than patch the test.
- **Risk:** a real staging deploy missing a var becomes an outage. _Mitigate:_ the config test in B runs in CI and blocks
  the merge; the rollout order in C catches the rest.
- **Risk:** `development` set in production by mistake. _Mitigate:_ the test in B asserts that only the `development`
  block may carry it.
- **Perf watch:** none expected; the change adds one branch per request.

## 9. Open questions — decided

1. **Should `development` be allowed in a deployed Worker at all?** Decided: no. It is honoured only under `wrangler dev`,
   and a deployed `development` value fails the check in B.
2. **Should the lineage refusal in §4.3 be a warning first?** Decided: no warning period. The change refuses only lineage
   headers that cannot be verified, which ordinary traffic never sends, so the blast radius is the forged-header case
   itself.
