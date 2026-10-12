# Plan 479 — Pin the rollback boundary: what a release owns, what it never owns, and what a rollback is allowed to do

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PARTIAL on `feat/cloud-dispatcher-fail-closed`. Workstream A shipped; B, C, D not done.

- **A shipped** as the `rollback boundary` describe in `apps/cloud/__tests__/release.test.ts`. A1 pins the
  `StoredRelease` and `DeployManifest` key sets with `Record<keyof T, true>`, so `tsc` rejects an added field. Verified
  by adding a field once (TS2741), then reverting. A1 also checks the JSON the deploy handler stores. A2 asserts a
  rollback uses the target row's crons, and none when the row has none. A3 runs a rollback through an allowlist proxy over
  the backend and deps: any other key throws and is recorded, and the recorded list must be empty. Sabotage-checked: an
  added backend read in `reprovision` and a dropped `cronSpecs` spread both turn it red.
- **B not done.** Studio copy on the rollback confirmation, out of scope for this change.
- **C not done.** The audit-row check (`GAPS.md:878`) is a separate piece of work.
- **D not done.** It needs a retention-window product decision (`GAPS.md:891`).

## 0. Headline finding

Lunora Cloud's rollback model is mostly right, and it is right by accident of structure, not by a test. The invariant worth making explicit:

> A rollback restores **code, manifest and config as they were at that release**. It never restores **policy** (suspension, plan, caps, edge rules,
> egress policy, protection, access, secrets, custom domains). Policy is read at request time from the control plane and is not in the stored release.

Today that holds: `StoredRelease` holds only the bundle, assets and manifest (`apps/cloud/src/deploy/release-store.ts:14-19`), and secrets are re-resolved fresh
(`release.ts:205`). But nothing asserts it, and the next policy added (plan 477's egress list, say) is one careless `manifest` field away from being rolled back.

Size: **S–M**.

## 1. Current state (audit)

- `apps/cloud/src/deploy/release-store.ts:8-10` — secrets are deliberately not stored. `:14-19` — `StoredRelease = { assets?, bundle, manifest }`.
- `apps/cloud/src/deploy/release.ts:337-343` — `rollbackRelease` calls `reprovision(..., { keepClasses: true })`, then `backend.rollbackDeployment`. The pointer
  moves only after provision succeeds. The comment at `:333-336` says no health check follows.
- `apps/cloud/src/deploy/release.ts:150` — `vars` ride in the spec's own `vars`, outside the manifest. A rolled-back release restores the `vars` current at that deploy.
- `apps/cloud/src/provision-contract.ts:35-40` — the `vars` comment says `vars` stay in the manifest "so the stored release … keeps them too". A deliberate decision.
- `apps/cloud/src/deploy/release.ts:257, 283` — `keepClasses` refuses a rollback that would drop a Durable Object class on targets with `dropsUnboundClasses`.
- Cron: `apps/cloud/src/deploy/release-core.ts:468` takes `cronSpecs` from the request; `release.ts:312` carries `target.cronSpecs` from the deployment row into the
  reprovision. A rollback reads crons from the **target deployment's row**. Probably correct; nothing tests it.
- `apps/cloud/GAPS.md:878` and `:891` — rollback audit coverage and a rollback control on superseded releases are open.

## 2. Existing seams (do not reinvent)

- `StoredRelease` is already the narrow record. Enforce the invariant by its _shape_, and test the shape.
- `resolveReleaseSpec` (`release.ts:205`) is the one place secrets and per-deploy values are resolved. Policy belongs next to it.
- The `keepClasses` guard (`release.ts:257-290`) is the precedent for a rollback that refuses rather than does something destructive.

## 3. The behavioural contract to preserve

- A rollback re-converges the stored bundle, assets, manifest and that deployment's crons.
- A rollback never changes: plan, suspension, caps, protection, recursion, edge rules, custom domains, egress policy (plan 477), access (plan 482), secrets.
- A failed rollback leaves the previous release live.

## 4. Design decisions

1. **`vars` stay with the release.** A rollback restores the `vars` of that deploy, because they are part of the app's configuration as the code was written.
   _Rejected:_ moving `vars` to live policy; every `wrangler` var would become a control-plane setting, against the no-lock-in promise.
   _UX:_ the rollback confirmation says so ("This also restores the environment variables from that release").
2. **A structural test, not a policy re-implementation.** `StoredRelease`'s key set is exactly `{ assets, bundle, manifest }`, and `DeployManifest` has no policy keys.
3. **No health check added.** The target passed a check when it first went live. A check changes rollback semantics and is a separate decision.

## 5. Workstreams

**A. Invariant tests (S).** (1) the `StoredRelease` key set is fixed; (2) a rollback reprovisions with the crons of the target deployment's row, and removes them when the row has none;
(3) a rollback never reads suspension, plan or edge state (a fake backend that throws on any policy read; the rollback must still complete).

**B. `vars` on the rollback confirmation (S).** The studio's rollback control states that the release's environment variables will be restored. Copy only.

**C. Audit row for rollback (S).** Close `GAPS.md:878`: the rollback writes an audit entry with source and target deployment ids. Check first whether the deploy route that calls `rollbackRelease` already writes one.

**D. Rollback on superseded releases (S, product).** Close `GAPS.md:891` only if the retention window still holds the bundle. Otherwise the control is offered only within the window, and the UI says so.

## 6. Platform parity

Not applicable. Cloud deploy-plane behaviour; no framework `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work    | Gate                                                                                                           |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------- |
| 1     | A       | Three tests green; the first fails when a policy field is added to `StoredRelease` (verify once by adding one) |
| 2     | B, C, D | Studio copy reviewed; audit row visible in the Activity tab                                                    |

## 8. Risks & STOP conditions

- **STOP** if test A2 shows crons are read from the stored release instead of the row. Fix the source of truth before anything else.
- **Risk:** a rolled-back `vars` value points at a decommissioned service. _Mitigate:_ the §4.1 copy; no automatic change.

## 9. Open questions — decided

1. **Should the operator choose `vars` at rollback time?** Decided: no. Restore by default and say so in the confirmation (§4.1). A per-rollback choice can come later if asked.
2. **Should a rollback run a health probe?** Decided: not in this plan. Revisit with plan 476's drill data.
