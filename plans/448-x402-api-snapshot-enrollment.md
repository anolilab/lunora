# Plan 448: Enrol `@lunora/x402` in the API-snapshot guard at the experimental tier

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- scripts/api-snapshot.js scripts/check-roadmap-tiers.js ROADMAP.md`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see "Ordering" — best landed after PR #436 merges)
- **Category**: dx
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

`pnpm run api:check` is a required CI job ("Lint (api surface)") and it is **green
and blind** for `@lunora/x402`: there is no `api-snapshots/x402.api.md`, because
`x402` appears in none of the tier lists in `scripts/api-snapshot.js`. A gate that
does not know a package exists cannot fail on it, and nothing in the local
`lint:*` / `test` set covers this — the memory-noted "CI gates beyond lint" trap.

Wave 22 shipped a real public-surface narrowing through that hole. On
`improve/wave22-x402` (PR [#436](https://github.com/anolilab/lunora/pull/436), commit
`1598fc34a`, "deps(x402): make chain toolchains optional peers"),
`resolveEvmAccount`'s return type changed:

```diff
-export const resolveEvmAccount = async (privateKey: string): Promise<PrivateKeyAccount> => {
+export const resolveEvmAccount = async (privateKey: string): Promise<ClientEvmSigner> => {
```

`ClientEvmSigner` is `address` + `signTypedData`; `PrivateKeyAccount` is viem's much
wider account type. Any caller using a viem-only member off the returned value breaks.
The change is defensible (it removes a hard viem dependency from the published
declarations) — the problem is that it went through with **nothing recording it**.

The sibling case is already documented in the script itself
(`scripts/api-snapshot.js:158-165`): `container` was added to the experimental tier
after `ctx.containers` gained `exec` in plan 335, where "the plan asserted `api:check`
would gate it, and `api:check` had never heard of the package."

## Current state

### The guard's coverage

`scripts/api-snapshot.js` defines three tier arrays. `TIER_3` (`api-snapshot.js:166`):

```js
const TIER_3 = ["agent", "ai", "container", "platform-node"];
```

and its docblock (`api-snapshot.js:141-151`) states the rationale for snapshotting
experimental packages at all:

> Coverage here is EVIDENCE, not a promise. Graduating an experimental package asks
> "has its surface settled?", and nothing could answer that while no record of the
> surface existed — the question was decided by recollection. A snapshot makes the
> drift visible, and the SemVer commitment still arrives only at graduation.

The coverage gap, computed from the tier arrays vs. `packages/*`:

```
$ node -e '<parse TIER_1/2/3 from scripts/api-snapshot.js, diff against packages/*>'
angular        private=false  @lunora/angular
browser        private=false  @lunora/browser
payment        private=false  @lunora/payment
react-native   private=false  @lunora/react-native
replica        private=false  @lunora/replica
search-core    private=true   @lunora/search-core
x402           private=false  @lunora/x402
--- covered: 48   total package dirs: 55   missing: 7
```

`ls api-snapshots/ | wc -l` → **48**, matching the covered count exactly.

### Audit of the other six (asked for by the finding)

| Dir            | Published? | ROADMAP tier | Assessment                                                                                                                                                                                                                                                                                                                           |
| -------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x402`         | yes        | Experimental | **This plan.** Published, in ROADMAP's experimental bullet already, and has a demonstrated unguarded narrowing.                                                                                                                                                                                                                      |
| `payment`      | yes        | Experimental | Strongest next candidate — wave 22 filed **seven** payment plans (365-371) touching provider adapters and the entitlement path. File as a follow-up.                                                                                                                                                                                 |
| `replica`      | yes        | Experimental | Two wave-22 plans (399, 402) landed against it. Follow-up candidate.                                                                                                                                                                                                                                                                 |
| `browser`      | yes        | Experimental | One wave-22 plan (385, tests only). Lower urgency.                                                                                                                                                                                                                                                                                   |
| `angular`      | yes        | Experimental | Adapter surface; no wave-22 changes. Lower urgency.                                                                                                                                                                                                                                                                                  |
| `react-native` | yes        | Experimental | Thin re-export layer over `@lunora/react`; least surface of its own.                                                                                                                                                                                                                                                                 |
| `search-core`  | **no**     | (none)       | Private, bundled into server/do/sql-store — it has no published surface, so a snapshot would guard nothing external. `dispatch` and `auth-ui` are covered while private, so privacy alone is not a reason to skip; the reason here is that it has no `exports` consumers outside the bundle. **Leave uncovered; record the reason.** |

Enrol `x402` in this plan; the rest belong in their own change, sized against
`api:update`'s churn, and are listed here so the audit is on record rather than
re-derived.

### What enrolling x402 will and will not catch

**Evidence correction, and it matters for expectations.** `resolveEvmAccount` carries a
`@experimental` JSDoc tag (`packages/x402/src/pay/wallet.ts:103`, `:114`), and the
snapshot rule at `api-snapshot.js:29-31` is:

> Exports tagged `@experimental` (JSDoc) are pinned by name + kind only and explicitly
> excluded from signature tracking, so the experimental tier can churn without a
> snapshot update. Adding/removing the tag IS a gated change.

So enrolling x402 today would **not** by itself have failed on this particular
narrowing — `resolveEvmAccount` would render as
`_Tagged `@experimental` — signature not tracked; churn here does not fail the gate._`

`grep -rn "@experimental" packages/x402/src | wc -l` → **58** tags across 11 files, and
the root barrel's exports (`DEFAULT_FACILITATOR_URL`, `resolveFacilitatorUrl`,
`EVM_NETWORKS`, `isEvmNetwork`, `isSvmNetwork`, `NETWORK_TO_CAIP2`, `SVM_NETWORKS`,
`toCaip2`, and the config/network types) are the untagged remainder.

What enrolment **does** buy, which is exactly what TIER_3 exists for:

1. **Every export appearing or disappearing is gated**, tagged or not. A removed export
   is the sharpest break and it is caught unconditionally.
2. **The untagged surface is signature-tracked** — the part that has already settled.
3. **Adding or removing an `@experimental` tag is itself gated**, so the settling
   signal (tags coming off) becomes visible rather than being decided by recollection.

Do not oversell this in the commit message. The honest claim is "the surface is now on
record", not "this narrowing would have been blocked".

## Existing seams (do not reinvent)

- **`TIER_3` + the `TIERS` table** (`api-snapshot.js:166-193`) — enrolment is one array
  entry. The `TIERS` table already carries the experimental stability sentence; the
  header renders from it (`api-snapshot.js:435-441`), so no new prose is needed.
- **`pnpm run api:update`** generates the file. Never hand-write a snapshot.
- **`scripts/check-roadmap-tiers.js`** (root `postinstall`) asserts the script's tier
  lists and `ROADMAP.md`'s bullets agree. `ROADMAP.md:57-59` already lists `x402` in
  "**Experimental (excluded from the 1.0 promise…)**", so adding `x402` to `TIER_3`
  keeps that check green with no roadmap edit.
- **CI wiring already exists.** `.github/workflows/lint.yml:196` defines the
  `api-surface` job, `.github/file-filters.yml:21-26` lists `packages/**` in the
  `api_surface` filter, and `lint.yml:529` registers `api-surface` in the aggregate
  gate. **No workflow change is needed for this plan** — the new snapshot rides the
  existing job.

## The behavioural contract to preserve

1. No existing snapshot file changes. Only `api-snapshots/x402.api.md` is created.
2. `node scripts/check-roadmap-tiers.js` stays green (it runs on every `pnpm install`,
   and per the memory note a failing postinstall gate turns **every** CI job red in its
   setup step, with the cause invisible in the job that "failed").
3. The snapshot must be generated from a **fresh** `build:prod`-equivalent `dist` —
   `api-snapshot.js` reads built `.d.ts`, so a stale build writes a wrong snapshot.

## Design decisions

**D1 — TIER_3 (experimental), not TIER_2.** `ROADMAP.md` publishes `x402` as
Experimental, and `check-roadmap-tiers.js` fails the install if the two disagree.
TIER_2 would also be a SemVer promise this package is nowhere near making — the same
reasoning `api-snapshot.js:70-77` records for `platform-node`.

**D2 — Enrol x402 alone; file the other five as follow-ups.** Chosen over enrolling all
six published stragglers at once: each generates a large first snapshot, and a single
combined PR makes any one of them impossible to review. `x402` goes first because it has
a demonstrated unguarded change.

**D3 — Do not strip `@experimental` tags to widen tracking.** Tempting (it would make
the snapshot catch signature narrowings like the one that motivated this) but wrong:
the tags are load-bearing for the tier's whole "churn freely" bargain, and
`api-snapshot.js:610-635` actively **errors** if `@experimental` appears on an export of
a fully-tracked package. Tag removal is a graduation decision, not a gate-tuning one.

## Ordering

PR #436 (`improve/wave22-x402`) is not yet in `alpha` as of this plan's baseline. Land
this **after** #436 merges, so the first snapshot records the post-#436 surface and the
`resolveEvmAccount` narrowing is baked into the baseline rather than showing up as a
spurious first diff. If #436 has already merged, ignore this section.

## Commands you will need

| Purpose           | Command                                      | Expected on success                         |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| Install           | `pnpm install`                               | exit 0 (postinstall gates all pass)         |
| Fresh build       | `pnpm run build:packages`                    | exit 0                                      |
| Generate snapshot | `pnpm run api:update`                        | exit 0; creates `api-snapshots/x402.api.md` |
| Verify gate       | `pnpm run api:check`                         | exit 0, no diff                             |
| Roadmap agreement | `node scripts/check-roadmap-tiers.js`        | exit 0                                      |
| Prettier          | `pnpm run lint:prettier` (`:fix` to correct) | exit 0                                      |

## Scope

**In scope**:

- `scripts/api-snapshot.js` — add `"x402"` to `TIER_3`, and extend its docblock with the
  one-line reason (mirroring the `container` and `platform-node` paragraphs already there)
- `api-snapshots/x402.api.md` — **generated**, never hand-written

**Out of scope**:

- `ROADMAP.md` — already lists `x402` under Experimental; touching it would be churn.
- `.github/workflows/lint.yml` / `.github/file-filters.yml` — already wired.
- `packages/x402/**` — this plan adds no source change. In particular, do **not** touch
  `@experimental` tags (D3).
- Enrolling `payment`, `replica`, `browser`, `angular`, `react-native` — follow-ups.
- `search-core` — deliberately left uncovered; record the reason in the docblock.

## Git workflow

- Branch: `improve/followup-x402-api-snapshot`
- Commit: `dx(x402): enrol in the api-snapshot guard` (39 chars)

## Steps

### Step 1: Add x402 to TIER_3

In `scripts/api-snapshot.js:166`:

```js
const TIER_3 = ["agent", "ai", "container", "platform-node", "x402"];
```

Add a paragraph to the `TIER_3` docblock in the shape of the existing `container` one,
stating: the package was uncovered, a return-type narrowing on `resolveEvmAccount`
shipped with nothing recording it, and coverage here is evidence rather than a promise.
Also update the `Packages covered by the guard` docblock at `api-snapshot.js:61-67`,
which currently reads "The rest of the experimental tier (`replica`, `x402`,
`react-native`, `angular`, `browser`, `payment`) is not covered yet" — drop `x402` from
that sentence and note that `search-core` stays uncovered because it is bundled and has
no published surface.

**Verify**: `node scripts/check-roadmap-tiers.js` → exit 0 (`x402` is already in
ROADMAP's experimental bullet).

### Step 2: Build fresh, then generate

```
pnpm run build:packages
pnpm run api:update
```

`api-snapshot.js` reads the built `dist` `.d.ts` — a stale build writes a wrong
snapshot, which is the failure mode called out in AGENTS.md's CI-gates note.

**Verify**:

- `test -f api-snapshots/x402.api.md` → exists
- `git status --porcelain api-snapshots/` → shows exactly **one** new file
  (`?? api-snapshots/x402.api.md`) and **no** modified existing snapshots

### Step 3: Sanity-check the generated file

Confirm the header renders the experimental tier (compare with
`api-snapshots/platform-node.api.md`, which opens with `- Tier: experimental` and the
"carries NO SemVer promise until the package graduates" sentence), and that all three
export entry points appear as `##` sections: `@lunora/x402`, `@lunora/x402/charge`,
`@lunora/x402/pay` (matching `packages/x402/package.json`'s exports map). A subpath
missing from the snapshot means `collectEntries` did not resolve its `types` condition —
investigate rather than accept.

Confirm `resolveEvmAccount` is present and rendered as
`_Tagged `@experimental` — signature not tracked…_` — that is the expected, correct
output, not a bug (see "What enrolling x402 will and will not catch").

**Verify**:

- `grep -c '^## ' api-snapshots/x402.api.md` → 3
- `grep -n 'Tier: experimental' api-snapshots/x402.api.md` → 1 match
- `grep -n 'resolveEvmAccount' api-snapshots/x402.api.md` → at least 1 match

### Step 4: Prove the gate now bites

Temporarily delete an export line from `packages/x402/src/networks.ts` (e.g. drop
`isSvmNetwork` from the barrel), rebuild that one package, and run `api:check`.

**Verify**: `pnpm --filter "@lunora/x402" run build && pnpm run api:check` → **fails**,
naming the removed export. Then `git checkout -- packages/x402/`, rebuild, and confirm
`pnpm run api:check` → exit 0. Do not commit the temporary edit.

## Test plan

There is no unit-test surface here — the gate _is_ the test, and Step 4 is the
proof-of-bite. Also run a clean `pnpm install` to confirm the postinstall gate chain
(which includes `check-roadmap-tiers.js`) is green, since a failure there reddens every
CI job with a misleading cause.

## Platform parity

Not applicable — this is a repo tooling change. It adds, removes, and re-rates no
`ctx.*` surface, binding, or capability.

## Done criteria

- [ ] `api-snapshots/x402.api.md` exists and is committed
- [ ] `grep -n '"x402"' scripts/api-snapshot.js` shows it inside `TIER_3`
- [ ] `pnpm run api:check` exits 0
- [ ] `node scripts/check-roadmap-tiers.js` exits 0
- [ ] `pnpm install` completes with all postinstall gates green
- [ ] `pnpm run lint:prettier` exits 0
- [ ] `git status --porcelain api-snapshots/` shows only the one new file — no existing
      snapshot modified
- [ ] Step 4's deliberate-break check failed, and the tree is back to clean
- [ ] `ROADMAP.md` unchanged (`git diff --stat ROADMAP.md` empty)

## STOP conditions

- **STOP** if `pnpm run api:update` modifies any snapshot other than the new
  `x402.api.md`. That means the build was stale or another package's surface moved, and
  neither belongs in this commit.
- **STOP** if `node scripts/check-roadmap-tiers.js` fails — it should not, since
  `ROADMAP.md:57-59` already lists `x402`. A failure means the roadmap bullet moved and
  the mismatch needs its own decision.
- **STOP** if `@lunora/x402` fails to build. Generating a snapshot from a broken or
  partial `dist` records a wrong surface as the baseline, which is worse than no
  snapshot.
- **STOP** if the generated snapshot has fewer than 3 `##` sections — a missing subpath
  means the extractor did not see it, and a snapshot that silently covers two-thirds of
  a package is a false green.

## Maintenance notes

- The remaining uncovered published packages are `payment`, `replica`, `browser`,
  `angular`, `react-native`. `payment` is the highest-value next enrolment (seven
  wave-22 plans touched it). `search-core` stays out by decision, not by oversight —
  keep the reason in the docblock so the next audit does not re-litigate it.
- The recurring failure this closes is subtle: a package outside the tier lists produces
  **no** snapshot and **no** error. The gap is only visible by diffing `packages/*`
  against the tier arrays. If a check is ever wanted for that, it belongs beside
  `check-roadmap-tiers.js` in the postinstall chain — but weigh it against the fact that
  a deliberate exclusion (`search-core`) then needs an allowlist.
- Reviewer: check the commit message does not claim this would have blocked the
  `resolveEvmAccount` narrowing. It would not have — the export is `@experimental`-tagged.
