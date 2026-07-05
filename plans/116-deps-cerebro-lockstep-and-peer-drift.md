# Plan 116: Repin @bomb.sh/tab to cerebro's peer, guard the lockstep, and fix three peer-range drifts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/cli/package.json pnpm-workspace.yaml packages/payment/package.json packages/angular/package.json packages/nuxt/package.json scripts/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: deps / dx
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`@lunora/cli` depends on `@visulima/cerebro`, which declares **exact-version
optional peers** on `@bomb.sh/tab` and `@visulima/pail`. When the CLI's own pin
of one of those packages differs from cerebro's peer, published-CLI consumers
under npm/yarn **flat hoisting** end up with one copy that cannot satisfy both,
and `npx lunorash` crashes at boot with `ERR_MODULE_NOT_FOUND` (cerebro's
completion command top-level-imports tab). This exact bug was fixed in commit
`e323725a0` ("fix(cli): align @bomb.sh/tab pin with cerebro peer", set
`0.0.17 → 0.0.16`) and was **regressed nine hours later** by a routine deps
bump (`9a14fc6b0`, "deps(cli): bump @bomb.sh/tab to 0.0.17"). Because nothing
enforces the invariant, it will drift again — so this plan both repins and adds
a guard. It also fixes three unrelated peer-range drifts found in the same
audit (stripe, @angular/core, h3) that create "works in the monorepo, breaks
for consumers" contracts. Monorepo dev masks all of these (pnpm isolates
virtual instances; `peerDependencyRules` allows `>=0.0.15`), so the breakage
only surfaces for end users.

## Current state

- `packages/cli/package.json:69` — `"@bomb.sh/tab": "0.0.17"` (the regression).
  Line 76: `"@visulima/cerebro": "3.0.0-alpha.32"`. Line 79:
  `"@visulima/pail": "4.0.0-alpha.22"` (this one IS in lockstep).
- The **resolved** cerebro manifest (verify with the command in Step 1)
  declares, as **optional** peers:

    ```json
    {
        "@bomb.sh/tab": "0.0.16",
        "@visulima/boxen": "3.0.0-alpha.14",
        "@visulima/find-cache-dir": "3.0.0-alpha.12",
        "@visulima/pail": "4.0.0-alpha.22",
        "github-slugger": "2.0.0"
    }
    ```

- `pnpm-workspace.yaml` (~line 407, `peerDependencyRules.allowedVersions`
  block) contains `"@bomb.sh/tab": ">=0.0.15"` — this only _suppresses the
  warning_; it does not enforce equality.
- `pnpm-workspace.yaml:102-105` (catalog) pins `ai: 7.0.14`,
  `workers-ai-provider: 3.3.1`, `"@ai-sdk/anthropic": 4.0.7`,
  `"@ai-sdk/openai": 4.0.7`. The comment block above them (~lines 88-101)
  still says "Vercel AI SDK **v6**" and instructs: "To bump: update the version
  here AND its matching exclude entry together." But `minimumReleaseAgeExclude`
  (~lines 437-487) still lists the **stale** entries
  `'@ai-sdk/anthropic@3.0.83'`, `'@ai-sdk/openai@3.0.70'`, `'ai@6.0.202'` —
  versions that are no longer installed. The block's own header comment says
  "When bumping a dependency, UPDATE its existing line — do not append a new
  one."
- `packages/payment/package.json:80` — peer `"stripe": "^19.0.0"`, while the
  reference consumer `examples/payment-demo/package.json:22` installs
  `"stripe": "^22.3.0"` (3 majors apart; stripe is not catalog-managed).
- `packages/angular/package.json:62` — devDependency
  `"@angular/core": "^22.0.5"` (what it is actually built/tested against), but
  line 73 peer is `"@angular/core": "^19.2.0 || ^20.0.0"` — excluding v21/v22.
- `packages/nuxt/package.json:76` — devDependency `"h3": "^1.15.11"` (correct;
  npm's `h3@2.0.0` is a **deprecated empty stub** — the real v2 is only
  prerelease `2.0.1-rc.x`), but line 81 peer is `"h3": "^1.0.0 || ^2.0.0"`,
  which still admits the broken stub for consumers.

Repo conventions: pnpm 11.5.3 monorepo, `"type": "module"` at the root, shared
versions live in pnpm catalogs (but `@visulima/*` alphas and these peers are
deliberately exact/local). Root helper scripts live in `scripts/*.js` (see
`scripts/check-cla.js` for the style: plain Node ESM, no deps). Enforced
conventional-commit types: `build, chore, ci, deps, docs, feat, fix, perf,
refactor, revert, security, style, test, translation` (note: `dx` is NOT
accepted despite older docs).

## Commands you will need

| Purpose                      | Command                                                                                  | Expected on success              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| Install / relock             | `pnpm install`                                                                           | exit 0                           |
| CLI tests                    | `pnpm --filter "@lunora/cli" run test`                                                   | all pass                         |
| CLI types (build deps first) | `pnpm --filter "@lunora/cli..." run build && pnpm --filter "@lunora/cli" run lint:types` | exit 0                           |
| Guard script                 | `node scripts/check-cerebro-peer-lockstep.js`                                            | exit 0, no output (or "OK" line) |

## Scope

**In scope** (the only files you should modify):

- `packages/cli/package.json` (the tab repin)
- `pnpm-workspace.yaml` (exclude-list sync + comment fix)
- `packages/payment/package.json`, `packages/angular/package.json`,
  `packages/nuxt/package.json` (peer ranges only)
- `scripts/check-cerebro-peer-lockstep.js` (create)
- Root `package.json` (wire the guard into `postinstall`)
- `pnpm-lock.yaml` (regenerated by `pnpm install`)

**Out of scope** (do NOT touch):

- Bumping `@visulima/cerebro` itself, or any other dependency version.
- The `peerDependencyRules` block (leave the warning suppression as-is).
- Any `catalog:` reference in any package.
- `examples/payment-demo` (its stripe version is the reference point, not the bug).

## Git workflow

- Branch: `advisor/116-deps-cerebro-lockstep`
- Suggested commits: `fix(cli): repin @bomb.sh/tab to cerebro's exact peer` +
  `build: guard cerebro peer lockstep and sync ai-sdk exclude entries` +
  `deps: realign stripe/angular/h3 peer ranges`

## Steps

### Step 1: Confirm cerebro's resolved peer versions

Run:

```
cat "$(ls -d node_modules/.pnpm/@visulima+cerebro@3.0.0-alpha.32*/ | head -1)node_modules/@visulima/cerebro/package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).peerDependencies,null,1)))"
```

**Verify**: output shows `"@bomb.sh/tab": "0.0.16"` and
`"@visulima/pail": "4.0.0-alpha.22"`. If tab is anything other than `0.0.16`,
STOP (see STOP conditions).

### Step 2: Repin `@bomb.sh/tab`

In `packages/cli/package.json`, change `"@bomb.sh/tab": "0.0.17"` →
`"@bomb.sh/tab": "0.0.16"`. Run `pnpm install`.

**Verify**: `pnpm install` exits 0, and
`grep '"@bomb.sh/tab"' packages/cli/package.json` shows `0.0.16`.

### Step 3: Create the lockstep guard script

Create `scripts/check-cerebro-peer-lockstep.js` (plain Node ESM, zero deps,
style-match `scripts/check-cla.js`). Behavior:

1. Resolve the installed cerebro manifest. Use
   `createRequire(import.meta.url).resolve("@visulima/cerebro/package.json", { paths: [<repo-root>/packages/cli] })`
   — resolving **from `packages/cli`** so you get the copy the CLI actually
   links. If resolution throws (fresh clone mid-bootstrap), print a notice and
   `process.exit(0)` (the guard must never block bootstrap).
2. Read `packages/cli/package.json`. For each of `@bomb.sh/tab` and
   `@visulima/pail`: if cerebro declares it in `peerDependencies` AND the CLI
   declares it in `dependencies`/`devDependencies`, assert the CLI's version
   string **equals** cerebro's peer string exactly.
3. On mismatch: print both values plus the remediation line
   `Pin packages/cli's <name> to <cerebro-peer-version> (see commit e323725a0)`
   and `process.exit(1)`.

Wire it into the root `package.json` `postinstall`, appending
`&& node scripts/check-cerebro-peer-lockstep.js` to the existing chain
(currently `node scripts/generate-package-og-images.js && node scripts/generate-labeler-config.js --skip-ci`).

**Verify**: `node scripts/check-cerebro-peer-lockstep.js` → exit 0. Then
temporarily edit the CLI pin to `0.0.99`, run the script again → exit 1 with
both versions printed; revert the temporary edit.

### Step 4: Sync the AI-SDK exclude entries

In `pnpm-workspace.yaml` `minimumReleaseAgeExclude`, **update in place** (do
not append): `'@ai-sdk/anthropic@3.0.83'` → `'@ai-sdk/anthropic@4.0.7'`,
`'@ai-sdk/openai@3.0.70'` → `'@ai-sdk/openai@4.0.7'`, `'ai@6.0.202'` →
`'ai@7.0.14'`. Add `'workers-ai-provider@3.3.1'` in alphabetical position if
absent. In the catalog comment block (~lines 88-101), change the "v6" prose to
v7 (and "provider peers `ai ^6.0.0`" to the v7 equivalent). Leave
`@ai-sdk/provider-utils@4.0.28` and `@ai-sdk/gateway@3.0.128` untouched
(transitives, separately managed).

**Verify**: `pnpm install` exits 0 (no `ERR_PNPM_NO_MATURE_MATCHING_VERSION`).

### Step 5: Realign the three peer ranges

- `packages/payment/package.json`: peer `"stripe": "^19.0.0"` →
  `"^19.0.0 || ^20.0.0 || ^21.0.0 || ^22.0.0"`.
- `packages/angular/package.json`: peer `"@angular/core": "^19.2.0 || ^20.0.0"`
  → `"^19.2.0 || ^20.0.0 || ^21.0.0 || ^22.0.0"`.
- `packages/nuxt/package.json`: peer `"h3": "^1.0.0 || ^2.0.0"` → `"^1.15.0"`
  (drop v2 until a stable h3 v2 actually exists on npm; the devDependency pin
  at line 76 stays `"^1.15.11"`).

Run `pnpm install` to relock.

**Verify**: `pnpm install` exit 0;
`pnpm --filter "@lunora/payment" run test`,
`pnpm --filter "@lunora/angular" run test`, and
`pnpm --filter "@lunora/nuxt" run test` all pass (build deps first if you hit
missing-dist errors: `pnpm --filter "@lunora/<pkg>..." run build`).

## Test plan

No new unit tests — the guard script is the regression test for C1/C2 (its
negative case is exercised manually in Step 3). The three peer edits are
metadata-only; the per-package test suites above are the gates.

## Done criteria

- [ ] `grep '"@bomb.sh/tab"' packages/cli/package.json` → `"0.0.16"`
- [ ] `node scripts/check-cerebro-peer-lockstep.js` → exit 0
- [ ] Root `package.json` `postinstall` invokes the guard script
- [ ] `grep -n 'ai@6\|@3.0.83\|@3.0.70' pnpm-workspace.yaml` → no matches
- [ ] `pnpm install` → exit 0
- [ ] `pnpm --filter "@lunora/cli" run test` → all pass
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Cerebro's resolved peer for `@bomb.sh/tab` is not `0.0.16` (a newer cerebro
  landed) — the correct pin is then _that_ value, but confirm with the operator
  before diverging from this plan's literals.
- `pnpm install` fails after the repin for any reason other than the lockfile
  needing regeneration.
- The `minimumReleaseAgeExclude` update triggers
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION` for a version this plan told you to
  write (the version aged out or the registry disagrees — report the exact
  error).
- Any peer-range widening causes a resolution error in an example/template
  project.

## Maintenance notes

- Any future `deps(cli)` bump of `@bomb.sh/tab` or `@visulima/pail`, and any
  cerebro bump, must keep the pins equal to cerebro's peers — the postinstall
  guard now fails the install if not. Renovate PRs that bump tab alone will go
  red; that is the intended behavior (bump cerebro and tab together).
- When h3 ships a **stable** v2 on npm, restore `|| ^2.0.0` on the nuxt peer
  and bump the devDep — do not accept a Renovate re-bump to `^2.0.0` before
  then (npm's `2.0.0` is a deprecated stub).
- Consider catalog-managing `stripe` if a third package ever needs it.
