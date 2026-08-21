# Plan 451: Make private packages use `workspace:*` for intra-repo deps, and enforce it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/dispatch/package.json scripts/check-sibling-peer-ranges.js pnpm-workspace.yaml .multi-releaserc.json`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: release
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

This repo pins intra-repo `dependencies` to **exact versions** rather than
`workspace:*`. That convention only works because something rewrites the pins on every
release. `pnpm-workspace.yaml:749-756` says so:

```yaml
# multi-semantic-release rewrites every intra-repo dependency from `workspace:*`
# to the exact released version (e.g. "@lunora/errors": "1.0.0-alpha.9") and
# commits that. pnpm 10+ defaults `linkWorkspacePackages` to false, which makes
# those pins resolve from the npm registry instead of the local package — so a
# lockfile refresh would silently swap workspace sources for published tarballs
# and `preferWorkspacePackages` below would be inert (it only applies once
# linking is enabled). Keep this true so released pins still link locally.
linkWorkspacePackages: true
```

A **private** package never releases, so nothing ever rewrites its manifest. Its pin
freezes at whatever version was current when it was last hand-edited, and the moment
the local sibling's version moves past it, the pin no longer matches the workspace
copy — so it resolves from the **npm registry tarball** instead.

For `packages/dispatch` that is not academic: it is `"private": true`, it is a
**devDependency** of `@lunora/queue` and `@lunora/workflow` (so packem **inlines** it
into their published bundles), and it pins `@lunora/errors` at a version the workspace
has already passed. A frozen registry copy of `@lunora/errors` getting inlined into two
shipped packages means the error catalog, the `LunoraError` class identity, and the
`instanceof`/`isLunoraError` guards inside those bundles can diverge from the rest of
the app's.

## Current state

### The offender

```
$ node -e '<read packages/dispatch/package.json>'
{ "private": true, "version": "1.0.0-alpha.1",
  "dependencies": { "@lunora/errors": "1.0.0-alpha.21" } }
```

The workspace copy is at `1.0.0-alpha.22` (`packages/errors/package.json`). The pin no
longer matches.

The pin arrived by hand, not by a release: commit `8411e1740`
("chore(deps): sync manifests, catalogs and lockfile (#410)") bumped it
`1.0.0-alpha.11 → 1.0.0-alpha.21`. It has drifted again since.

### The two correctly-shaped private packages

```
auth-ui      private=true  {"@lunora/auth":"workspace:*","@lunora/errors":"workspace:*","@lunora/react":"workspace:*", …}
search-core  private=true  {"@lunora/errors":"workspace:*"}
dispatch     private=true  {"@lunora/errors":"1.0.0-alpha.21"}
```

So the convention already exists; `dispatch` is the single divergence.

### The bundling that makes it severe

```
$ node -e '<read packages/{queue,workflow}/package.json>'
queue     @lunora/dispatch → deps:false  devDeps:true
workflow  @lunora/dispatch → deps:false  devDeps:true
```

A devDependency of a published package is bundled, not resolved by the consumer — so
whatever `@lunora/errors` `dispatch` links against is what ships inside
`@lunora/queue` and `@lunora/workflow`.

### The trap: the lockfile hides it

```
$ grep -n "packages/dispatch:" -A 5 pnpm-lock.yaml
  packages/dispatch:
    dependencies:
      '@lunora/errors':
        specifier: workspace:*
        version: link:../errors
```

The lockfile still records `specifier: workspace:*` and `version: link:../errors` —
i.e. the resolution CI installs today is the _correct_ one, because the lockfile predates
the manifest edit and nothing has regenerated that importer since. Local `pnpm install`
and every CI job are therefore green on a manifest that says something else. The
divergence only materialises when a lockfile refresh regenerates the importer — which
the release workflow does deliberately:
`.github/workflows/semantic-release.yml:157-161` runs
`pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts` with the comment
"this step exists to regenerate the [lockfile]". That is the worst possible place for
the swap to first happen: mid-release, after merge, in a non-cancellable job.

### There is already a guard here — it just does not fail

`scripts/check-sibling-peer-ranges.js` runs in the root `postinstall`. It has two arms:
a hard-failing one for exact sibling **peerDependencies**, and a **report-only** one for
exact sibling **dependencies** that have drifted. Its docblock already names this exact
case (`check-sibling-peer-ranges.js:29-39`):

> Exact-pinned regular dependencies are this repo's _deliberate_ lockstep convention …
> But a consumer with no triggering commits since its dependency's last release keeps
> its stale pin indefinitely — **the terminal case is a `private: true` package that
> never releases at all.** That drift is invisible today (nothing walks `dependencies`)
> and, for a published sibling, means two installers of two different `@lunora/*`
> packages can resolve two physical copies of a shared dependency. This mode never
> fails the install — it only reports — because mid-release-train drift between trains
> is normal and expected.

Running it right now:

```
$ node scripts/check-sibling-peer-ranges.js
⚠️  packages/dispatch depends on "@lunora/errors": "1.0.0-alpha.21" — current is "1.0.0-alpha.22".
⚠️  1 sibling dependency pin(s) are behind the current published version (report-only, does not fail install).
✅ No exact @lunora/* or lunorash peerDependency pins; multi-semantic-release keeps ranges (deps.bump: satisfy).
exit=0
```

The guard sees it. It just prints a `⚠️` in a wall of install output and exits 0.

### Repo-wide sweep of `"private": true` packages

Across `packages/*`, `apps/*`, `examples/*`, `tests/*`, checking `dependencies`,
`devDependencies`, `peerDependencies`, and `optionalDependencies` for an intra-repo name
whose specifier is neither `workspace:` nor `catalog:`:

```
packages/dispatch   dependencies   @lunora/errors   pinned=1.0.0-alpha.21   workspace=1.0.0-alpha.22
```

**One offender.** The sweep is worth keeping as the executor's Step 2 verification
rather than trusting this line — the number is a snapshot.

## Existing seams (do not reinvent)

- **`scripts/check-sibling-peer-ranges.js`** already walks every `packages/*` manifest,
  already builds the `versions` map, already distinguishes `workspace:` specifiers, and
  already reports this exact drift. **Extend its dependency arm with a hard-fail branch
  for private packages.** Do not add a new `scripts/check-*.js` for a rule this file
  already computes — the second script would duplicate the manifest walk and the
  `isSibling` predicate.
- **The root `postinstall` chain** (`package.json`) already runs it. No workflow wiring
  is needed — and per the lint-workflow convention, a _new_ standalone lint job would
  need registering in three places in `.github/workflows/lint.yml` including the
  `files-changed` `outputs` allowlist, where an undeclared key means the job never runs
  and the check stays green. Reusing the postinstall script sidesteps all of that.
- **`EXACT_VERSION_RE` and `isSibling`** in the same file are the predicates to reuse.

## The behavioural contract to preserve

1. The existing **peerDependency** hard-fail arm keeps working unchanged.
2. The existing **published-package dependency** report-only arm stays report-only —
   its docblock reason ("mid-release-train drift between trains is normal and expected")
   is correct and applies only to packages the release train rewrites.
3. `.multi-releaserc.json`'s `deps.bump: "satisfy"` assertion at the bottom of the script
   keeps working.
4. `pnpm install` must still succeed after the fix (the postinstall gate is in the same
   run, so a wrong hard-fail bricks every install and — per the known trap — reddens
   every CI job in its setup step with the cause invisible in the job that "failed").

## Design decisions

**D1 — `workspace:*` for private packages, not a widened range.**
A private package has no published consumers, so there is no npm-side range to satisfy;
`workspace:*` always links the local copy and can never go stale. This is what `auth-ui`
and `search-core` already do.

**D2 — Extend the existing check; do not write a new script.**
See "Existing seams". A hard-fail branch is ~10 lines inside a loop that already exists.

**D3 — Hard-fail on ANY non-`workspace:`/`catalog:` intra-repo specifier in a private
package, not only a drifted one.**
Chosen over "fail only when the pin no longer matches the workspace version": a pin that
happens to match today is a time bomb that arms itself the next time the sibling
releases, and the failure would then appear in an unrelated PR. Fail on the shape, not
on the current drift.

**D4 — Scope the new check to `packages/*`, matching the existing script.**
The script already reads only `packages/`. Widening it to `apps/`, `examples/`, and
`tests/` is a bigger change (those have different conventions and some are intentionally
version-pinned scaffolding fixtures) and the sweep found no offender there. Do the sweep
in Step 2 to confirm, and if one turns up outside `packages/`, file it separately rather
than widening the script in this commit.

**D5 — Regenerate the lockfile importer, do not hand-edit it.**
Per the repo rule, `pnpm-lock.yaml` is never edited by hand. `pnpm install` after the
manifest change updates the importer. It should be a no-op diff for `dispatch` (the
lockfile already says `workspace:*`), which is itself worth asserting.

## Commands you will need

| Purpose             | Command                                                                                  | Expected on success                 |
| ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| Install             | `pnpm install`                                                                           | exit 0, all postinstall gates green |
| Run the guard alone | `node scripts/check-sibling-peer-ranges.js`                                              | exit 0 after the fix                |
| package.json order  | `pnpm run lint:package-json` (`:fix` to correct)                                         | exit 0                              |
| Build the bundlers  | `pnpm --filter "@lunora/queue" --filter "@lunora/workflow" run build`                    | exit 0                              |
| Tests               | `pnpm --filter "@lunora/dispatch" run test`                                              | all pass                            |
| Downstream tests    | `pnpm --filter "@lunora/queue" run test` and `pnpm --filter "@lunora/workflow" run test` | all pass                            |
| Typecheck           | `pnpm run lint:types`                                                                    | exit 0                              |
| Prettier            | `pnpm run lint:prettier`                                                                 | exit 0                              |

## Scope

**In scope**:

- `packages/dispatch/package.json` — `@lunora/errors` → `workspace:*`
- `scripts/check-sibling-peer-ranges.js` — add the private-package hard-fail branch and
  extend the docblock
- `pnpm-lock.yaml` — regenerated by `pnpm install`, never hand-edited
- Any further offender the Step 2 sweep finds **inside `packages/*`**

**Out of scope**:

- Exact pins in **published** packages — that is the deliberate lockstep convention
  (`pnpm-workspace.yaml:749-756`) and the release train rewrites them.
- `apps/`, `examples/`, `tests/` — see D4.
- `.github/workflows/lint.yml` / `.github/file-filters.yml` — no new job (see seams).
- `.multi-releaserc.json`.
- `packages/queue` / `packages/workflow` manifests — they already use `workspace:*` for
  `@lunora/dispatch`.

## Git workflow

- Branch: `improve/followup-private-workspace-pins`
- Commit: `fix(deps): pin private package deps to workspace:*` (49 chars)
- Commit body must explain that a private package's exact pin is never rewritten by the
  release train and silently resolves to the registry tarball once the local version
  stops satisfying it — and that for `dispatch` that tarball would be inlined into
  `@lunora/queue` and `@lunora/workflow`.

## Steps

### Step 1: Fix `packages/dispatch`

Change `"@lunora/errors": "1.0.0-alpha.21"` to `"@lunora/errors": "workspace:*"`.

**Verify**:

- `node -e 'console.log(require("./packages/dispatch/package.json").dependencies)'` →
  `{ '@lunora/errors': 'workspace:*' }`
- `pnpm run lint:package-json` → exit 0 (key order is enforced by its own CI job and by
  nothing else; a manifest edit is exactly when it bites)

### Step 2: Sweep every private package and confirm the count

Run this and record the output in the PR description:

```
node -e '
const fs=require("fs");
const dirs=["packages","apps","examples","tests"];
const versions={};
for(const d of dirs){ if(!fs.existsSync(d))continue; for(const p of fs.readdirSync(d)){const f=d+"/"+p+"/package.json"; if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f,"utf8")); versions[j.name]=j.version;}}}
for(const d of dirs){ if(!fs.existsSync(d))continue; for(const p of fs.readdirSync(d)){const f=d+"/"+p+"/package.json"; if(!fs.existsSync(f))continue; const j=JSON.parse(fs.readFileSync(f,"utf8")); if(!j.private)continue;
 for(const field of ["dependencies","devDependencies","peerDependencies","optionalDependencies"]){
  for(const [dep,range] of Object.entries(j[field]||{})){
   if(!(dep in versions))continue;
   if(typeof range==="string" && !range.startsWith("workspace:") && !range.startsWith("catalog:")){
    console.log(`${d}/${p} ${field} ${dep} pinned=${range} workspace=${versions[dep]}`);
   }}}}}
'
```

**Verify**: after Step 1, this prints **nothing**. If it prints an offender under
`packages/*`, fix it the same way. If it prints one under `apps/`, `examples/`, or
`tests/`, do **not** fix it here — record it and file a separate issue (D4).

### Step 3: Add the hard-fail branch to the existing guard

In `scripts/check-sibling-peer-ranges.js`, the manifest loop already reads each
`package.json` into `manifests`. Capture `manifest.private` alongside `dir` and
`manifest`, then in the dependency arm split the two cases:

- **private package** → `hasFailure = true` with an actionable message: the package
  never releases, so nothing rewrites the pin; use `workspace:*`.
- **published package** → the existing `⚠️` report-only path, unchanged.

Apply it to `dependencies` **and** `devDependencies` (dispatch's own situation is a
dependency, but `queue`/`workflow` show that a devDependency is what gets bundled — a
stale devDependency pin in a private package has the same failure mode).

Trigger on the **shape** (`!startsWith("workspace:") && !startsWith("catalog:")`), not
on drift (D3).

Extend the docblock: it already says "the terminal case is a `private: true` package
that never releases at all" and that the mode "never fails the install". That second
sentence stops being true for the private case and must be corrected in place, or the
next reader will trust it.

**Verify**:

- `node scripts/check-sibling-peer-ranges.js` → exit 0, and the `⚠️ packages/dispatch`
  line is **gone**
- Temporarily revert Step 1's manifest edit and re-run → exits **1** naming
  `packages/dispatch`. Restore the fix afterwards.

### Step 4: Regenerate the lockfile importer

```
pnpm install
```

**Verify**:

- exit 0, with every postinstall gate green
- `git diff pnpm-lock.yaml` → for `packages/dispatch` the importer already read
  `specifier: workspace:*`, so this should be a **no-op or near-no-op**. A large
  lockfile diff is a STOP condition (a text-merged or otherwise stale lockfile is a
  separate problem — regenerate with `pnpm install --lockfile-only`, never hand-resolve).

### Step 5: Prove the bundled consumers still build and pass

```
pnpm run build:packages
pnpm --filter "@lunora/dispatch" run test
pnpm --filter "@lunora/queue" run test
pnpm --filter "@lunora/workflow" run test
```

**Verify**: all exit 0. These are the two packages that inline `dispatch`; if the
`@lunora/errors` copy `dispatch` links against changes at all, this is where it shows.

### Step 6: Whole-repo gates

**Verify**:

- `pnpm run lint:types` → exit 0
- `pnpm run lint:package-json` → exit 0
- `pnpm run lint:prettier` → exit 0
- `pnpm run api:check` → exit 0 (`dispatch` is TIER_2-covered; its surface must not move)

## Test plan

- **Exemplar**: there is no unit-test suite for the `scripts/check-*.js` family — they
  are install-time gates whose test is running them. `scripts/check-roadmap-tiers.js`
  and `scripts/no-nul-bytes.mjs` are the shape to match (a bare Node script, a clear
  stderr message, `process.exit(1)`).
- The **proof-of-bite** is Step 3's temporary revert: the guard must exit 1 on the
  offending manifest and 0 once fixed. Do this and report the result; a gate nobody
  verified fails is how this class of bug persists.
- The behavioural test is Step 5: `@lunora/queue` and `@lunora/workflow` build and pass
  with the relinked `@lunora/errors`.

## Platform parity

Not applicable — this is a dependency-resolution and repo-tooling change. It adds,
removes, and re-rates no `ctx.*` surface, binding, or capability.

## Done criteria

- [ ] `packages/dispatch/package.json` depends on `"@lunora/errors": "workspace:*"`
- [ ] Step 2's sweep prints nothing for `packages/*`
- [ ] `node scripts/check-sibling-peer-ranges.js` exits 0 with no `⚠️` for dispatch
- [ ] Reverting the manifest fix makes that script exit **1** (proof-of-bite recorded)
- [ ] `pnpm install` exits 0 with all postinstall gates green
- [ ] `git diff --stat pnpm-lock.yaml` shows a no-op or minimal importer-only change
- [ ] `pnpm --filter "@lunora/queue" run test` and
      `pnpm --filter "@lunora/workflow" run test` exit 0
- [ ] `pnpm run lint:package-json` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] No new `scripts/check-*.js` file was added (`git status --porcelain scripts/`
      shows only `check-sibling-peer-ranges.js` modified)

## STOP conditions

- **STOP** if `pnpm install` fails after the guard change. A postinstall gate failure
  turns **every** CI job red in its setup step, with the cause invisible in the job that
  reports the failure — so a wrong hard-fail is far more expensive than the bug. Verify
  the guard passes on a clean tree before committing.
- **STOP** if `git diff pnpm-lock.yaml` is large. The importer already recorded
  `workspace:*`; a big diff means something else about the lockfile is stale, which is a
  separate change. Never hand-resolve it — regenerate with
  `pnpm install --lockfile-only`.
- **STOP** if `@lunora/queue` or `@lunora/workflow` tests fail after relinking. That
  would mean the bundles were genuinely depending on the older `@lunora/errors`
  behaviour, which is a real (and worse) finding needing its own investigation.
- **STOP** if the sweep finds an offender in `apps/`, `examples/`, or `tests/` — record
  it, do not widen this commit (D4).
- **STOP** if `pnpm run api:check` reports a `dispatch` surface change. Relinking should
  change nothing observable.

## Maintenance notes

- The rule to remember: **`workspace:*` for private packages, exact pins for published
  ones.** Published pins are rewritten by multi-semantic-release on every release;
  private ones are rewritten by nothing.
- The reason this stayed invisible is worth keeping: the lockfile records the _old_
  specifier, so `pnpm install` and every CI job stay green on a manifest that says
  something different. The divergence only surfaces when the release workflow's
  `--lockfile-only --no-frozen-lockfile` step regenerates the importer — after merge, in
  a non-cancellable job. A green local install is not evidence the manifest is right.
- Reviewer: check the published-package arm is still **report-only**. Making it fail
  would break every legitimate mid-release-train state and brick installs across the
  repo.
