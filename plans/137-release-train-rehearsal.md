# 137 — Release-train rehearsal (plan 135, Phase 3 promotion mechanics)

Rehearsal of the `alpha → main` stable-1.0.0 promotion, executed 2026-07-16/17
in an isolated worktree at `1c6d1f17` ("docs: tick coverage-gap item in 1.0
roadmap"). Nothing was published or pushed: all runs used
`multi-semantic-release --dry-run` with dummy tokens against a **local-only**
`main` branch (created at HEAD, deleted afterwards); remote `main` was verified
unchanged before and after.

## 1. Dry-run transcript summary

Setup: local `main` branched at HEAD (simulating the alpha→main merge),
semantic-release channel notes fetched (`git fetch origin
'+refs/notes/*:refs/notes/*'`, 1134 refs — required, see §1.3), env
`GITHUB_TOKEN=dummy GH_TOKEN=dummy NPM_TOKEN=dummy`.

### 1.1 Run 1 — shipped config, `--dry-run` (blocked at verifyConditions)

`pnpm exec multi-semantic-release --dry-run` with the real per-package
`.releaserc.json` (extends `@anolilab/semantic-release-preset/pnpm`):

- msr 4.4.4 / semantic-release 25.0.5 loaded and queued **46 packages**
  (topologically, `@lunora/errors` first) — the full publishable set including
  the `lunorash` umbrella.
- Branch detection worked: "Run automated release from branch main … in
  dry-run mode"; "Allowed to push to the Git repository".
- **Aborted in `verifyConditions`** with `EINVALIDNPMTOKEN`
  (`@anolilab/semantic-release-pnpm` verifies the npm token against
  registry.npmjs.org even under `--dry-run`) and `EINVALIDGHTOKEN`
  (`@semantic-release/github` verifies the token against api.github.com).

**Classification: blocked-by-sandbox, not blocked-by-config.** Both plugins
intentionally verify credentials in dry-run; with real (read-scoped) tokens a
maintainer can dry-run the _shipped_ config end-to-end. No config change is
needed.

### 1.2 Run 2 — verify-free rehearsal config (full success)

To rehearse version computation past the token gates, the 46
`.releaserc.json` files were **temporarily** (working tree only, reverted
after) replaced with a config keeping the preset's `branches` array verbatim
and only `@semantic-release/commit-analyzer` +
`@semantic-release/release-notes-generator` (both `preset:
"conventionalcommits"`). Result — **"Released 46 of 46 packages,
semantically!"**:

- Every package logged `No git tag version found on branch main` → `No
previous release found` → analyzed all 1472 commits → **"There is no
  previous release, the next release version is 1.0.0"**.
- **All 46 packages compute `1.0.0`** — `@lunora/server`, `@lunora/cli`,
  `@lunora/values`, …, `@lunora/x402`, and the **`lunorash` umbrella** — each
  "Published release 1.0.0 on **default channel**" (dry-run).
- Tag creation skipped 46× ("Skip @lunora/*@1.0.0 tag creation in dry-run
  mode"); prepare/publish/success steps skipped; no pushes.
- Release notes carry the local-dependency sections, e.g. `@lunora/codegen
1.0.0` lists "**@lunora/server:** upgraded to 1.0.0" etc.; `lunorash`'s
  notes list all its base packages upgraded to 1.0.0.
- Post-run verification: no new local tags created (only 2 _fetched_
  `@lunora/replica@1.0.0-alpha.{1,2}` alpha tags auto-followed from origin),
  `git ls-remote origin refs/heads/main` unchanged (`63f7f88c`), no
  `chore(release)` commits, no `.npmrc` residue (one transient
  `packages/errors/.npmrc` from run 1's verify step was deleted; it contained
  only the dummy token).

### 1.3 Channel notes are load-bearing

The clean "no previous release → 1.0.0" computation depends on the
`refs/notes/semantic-release-<tag>` channel notes: they map every
`@lunora/*@1.0.0-alpha.N` tag to the `alpha` channel so semantic-release
excludes them from `main`'s (default) channel. Without the notes fetched, the
alpha tags (reachable from main after the merge) could be mis-read as
default-channel releases. The workflow already re-fetches all notes refs
explicitly (belt-and-suspenders step in
`.github/workflows/semantic-release.yml`) — keep that step.

### 1.4 `deps.bump: "satisfy"` — peer ranges survive

`.multi-releaserc.json` sets `deps.bump: "satisfy"`. msr's range updater keeps
an existing range **unchanged** when the new version satisfies it, and
rewrites it to `deps.prefix + version` (prefix defaults to `""` → exact)
otherwise. Verified with semver 7 against the actual manifests:

| Range in repo                                                                     | `1.0.0` satisfies? | satisfy-mode outcome             |
| --------------------------------------------------------------------------------- | ------------------ | -------------------------------- |
| peer `>=1.0.0-alpha.24 <2.0.0-0` (cloudflare-access, replica, seed, config, vite) | yes                | **kept as-is** (survives 1.0)    |
| dep exact pin `1.0.0-alpha.4` (all runtime deps, incl. all 9 `lunorash` deps)     | no                 | **rewritten to `1.0.0`** (exact) |

So the Phase-3 peer re-pins survive promotion untouched, and the `lunorash`
umbrella's exact dependency pins resolve to the stable `1.0.0` versions —
matching the "upgraded to 1.0.0" release notes from the dry run.
`scripts/check-sibling-peer-ranges.js` (postinstall) passed at this commit.
Caveat: `--dry-run` skips `prepare`, so the manifest rewrite itself was
verified from msr's source + semver behavior, not from files on disk — the
real-token rehearsal (or the release run itself) is where the written
manifests can be observed.

### 1.5 What worked vs. what's blocked

Worked in this sandbox:

- Full msr pipeline mechanics: package discovery (46), topological queueing,
  branch/channel resolution on `main`, commit analysis over the full history,
  version computation (**1.0.0 everywhere**), notes generation with
  cross-package dependency sections, dry-run skips of tag/prepare/publish.
- Channel-note-based exclusion of alpha tags from the stable channel.
- `deps.bump: "satisfy"` semantics (source + semver verification).

Blocked-by-sandbox (needs a maintainer with real credentials):

- `verifyConditions` of `@anolilab/semantic-release-pnpm` and
  `@semantic-release/github` (token verification runs even in dry-run).
- The actual `prepare` (manifest version + dependency-range writes,
  changelog), `publish` (npm with OIDC provenance), tag+note pushes, GitHub
  releases — dry-run skips these by design.

Blocked-by-config (intentional, must be undone to cut 1.0):

- **`origin/main`'s workflow gates out stable releases**: commit `5dbd0195`
  ("ci: gate stable releases; publish only alpha prereleases") removed `main`
  from the Semantic Release push trigger on the `main` branch. The `alpha`
  branch's workflow (this checkout) has `main` back in the trigger, so the
  alpha→main merge itself restores the trigger — but the merged result must be
  checked (see runbook step 4).

Also note: `origin/main` and `origin/alpha` have **diverged** (main carries
its own CI-only commits: the gate, timeout bumps, js-yaml override scoping…).
The promotion is therefore a real merge, not a fast-forward.

## 2. `lunora init` version-rewrite at 1.0 — verdict: correct, now covered

`packages/cli/src/commands/init/handler.ts` stamps template `^0.0.0`
placeholders via `resolveDistTag()` / `resolveLunoraVersions()` (~lines
250–330, 406–430), and derives the default template `--ref` via
`resolveSourceRef()` → `resolveVersionRef()`
(`packages/cli/src/util/source-ref.ts`). Audit result:

- `resolveVersionRef("1.0.0")` → **`main`** (templates fetched from
  `gh:anolilab/lunora/templates/<type>#main`); pre-release channels map to
  their branch; only the unpublished `0.0.0` sentinel falls back to `alpha`.
  No hardcoded `alpha` ref anywhere else in the CLI source.
- `resolveDistTag()` for a stable CLI → **`latest`** (never `alpha`);
  pre-release CLIs keep their channel tag; scaffolds pin the _concrete_
  version the tag resolves to (registry lookup), falling back to the tag
  offline.

**No fix was needed** — the logic already promotes correctly. Added coverage
(all green, `@lunora/cli` 49 tests + `tsc --noEmit`):

- `resolveDistTag` made version-injectable (optional param, defaults to the
  running CLI version — behavior unchanged) and unit-tested:
  `1.0.0`→`latest`, channel versions→channel tag, `0.0.0`→`alpha`,
  unrecognized pre-release→`latest`, build-metadata ignored
  (`packages/cli/__tests__/util/source-ref.test.ts`).
- Stable template-ref derivation asserted (`1.0.0`→`main`).
- init-level test: registry tag resolving to stable `1.0.0` → scaffold pins
  `1.0.0` exactly, no `^0.0.0` residue
  (`packages/cli/__tests__/commands/init.test.ts`).

Caveat for a maintainer post-release: the end-to-end path (real npm `latest`,
real `#main` template fetch) is Phase-5 step 5 — `npx lunora@latest init`
against the live registry once 1.0.0 exists, and confirm `templates/` exists
on `main` after the merge.

## 3. npm `latest` dist-tag semantics — confirmed from preset + plugin source

From `@anolilab/semantic-release-preset/config/with-pnpm.json` (what every
`.releaserc.json` extends) and `@anolilab/semantic-release-pnpm@8.1.16`:

- The preset's `branches`: `main` is a **plain release branch** (no `channel`,
  no `prerelease`) → its releases go to semantic-release's **default
  channel**; `alpha`/`beta` are `{ prerelease: true, channel: "alpha"/"beta" }`.
- The pnpm publish plugin's channel→dist-tag mapping (`getChannel` in
  `dist/index.js`): **`undefined`/falsy channel → `"latest"`**; a named
  channel → that name (a semver-range channel would become `release-<range>`,
  not used here).
- Therefore: **the first stable publish from `main` lands on `latest`**, and
  **`alpha`-branch publishes keep the `alpha` dist-tag** (their channel is
  `alpha`). The dry run's 46× "Published release 1.0.0 on default channel"
  is exactly the `latest` path.
- The preset also wires the plugin's `addChannel` hook, so later channel
  promotions (e.g. a beta→stable re-tag via `pnpm dist-tag add`) are handled
  by semantic-release, not by hand.

Sandbox caveat: verified from config + plugin source and the dry-run channel
resolution; the actual `npm dist-tag ls` observation requires the real
publish (post-release check in the runbook).

## 4. Runbook — cutting 1.0.0

Pre-flight (on `alpha`, all green before any branch dance):

1. Phases 1–3 of plan 135 complete; feature freeze per Phase 5.
2. `pnpm install --frozen-lockfile && pnpm run build:packages && pnpm run
test && pnpm run lint:types` green; postinstall guards pass (notably
   `scripts/check-sibling-peer-ranges.js`).
3. Confirm `.multi-releaserc.json` still has `deps.bump: "satisfy"` and every
   `packages/*/.releaserc.json` still extends
   `@anolilab/semantic-release-preset/pnpm`.
4. Optional but recommended: real-token local dry run —
   `GITHUB_TOKEN=<read-scoped PAT> NPM_TOKEN=<read-scoped token> pnpm exec
multi-semantic-release --dry-run` on a local `main` at the merge candidate;
   expect 46× `1.0.0` / default channel (this rehearsal's run 2, but through
   the shipped config's verifyConditions).
5. Verify release plumbing in repo settings: `release` GitHub Environment
   exists with its required reviewers, secrets `NPM_TOKEN` (automation token,
   publish rights on `@lunora/*` + `lunorash`) and
   `SEMANTIC_RELEASE_GITHUB_TOKEN` present, npm trusted-publisher/OIDC
   provenance config intact (`id-token: write` is already in the workflow).

The branch dance (`main` and `alpha` have diverged — this is a merge, not a
fast-forward):

6. Open a PR merging `alpha` → `main`. Resolve conflicts keeping **alpha's**
   `.github/workflows/semantic-release.yml` — the `main`-side copy carries the
   stable-release gate (commit `5dbd0195`, `branches: ["alpha", "next",
"beta"]`); the merged file must have `"branches": ["main", "alpha",
"next", "beta"]`.
7. On the merge result, sanity-check: workflow triggers include `main`;
   `templates/` directory present (for `lunora init … #main` fetches);
   `pnpm-lock.yaml` consistent (`pnpm install --frozen-lockfile`).
8. Merge the PR. The push to `main` starts the Semantic Release workflow.

During the release run:

9. **Never cancel the run mid-flight.** The workflow's concurrency is
   `cancel-in-progress: false` for a reason: each package pushes a tag AND a
   channel note; cancelling between them strands a tag without its channel
   mapping and a later run dies with exit 128 on `git tag` (details in the
   workflow header comment).
10. Expected shape (from this rehearsal): 46 packages, each "no git tag
    version found on branch main" → next release `1.0.0` → publish to npm
    dist-tag `latest` → tag `<name>@1.0.0` + note → GitHub release →
    per-package `chore(release)` commit; finally the lockfile-refresh commit
    (`chore(deps): sync pnpm-lock.yaml …`).
11. If the run fails partway: fix the cause and **re-run the workflow** (runs
    queue, they don't cancel). Already-published packages are safe —
    semantic-release-pnpm logs "already published … skipping", and tag+note
    pairs make get-last-release idempotent.

Post-release verification:

12. `npm dist-tag ls @lunora/server` (spot-check a few + `lunorash`): expect
    `latest: 1.0.0` and `alpha: 1.0.0-alpha.<n>` still present.
13. `npm info @lunora/replica@1.0.0 peerDependencies` — the
    `>=1.0.0-alpha.24 <2.0.0-0` range must have survived (satisfy);
    `npm info lunorash@1.0.0 dependencies` — all `@lunora/*` at `1.0.0`.
14. `npx lunora@latest init -t tanstack-start-react smoke && cd smoke && pnpm
install && pnpm exec lunora codegen` — scaffold must pin `1.0.0` deps and
    fetch templates from `#main` (plan 135 Phase 5 step 5).
15. Merge `main` back into `alpha` (release commits, changelogs, lockfile) so
    the alpha channel continues from the stable baseline.

Rollback notes:

- npm versions are immutable — there is no un-publish path to plan around.
  A broken 1.0.0 is handled by publishing `1.0.1` from `main` (fix → merge →
  the train re-runs) and, if urgent, `npm deprecate <pkg>@1.0.0 "<reason>"`.
- Dist-tags are mutable and this was the _first_ stable, so there is no prior
  `latest` to restore; do NOT point `latest` back at an alpha prerelease —
  deprecate + patch forward instead.
- Never delete published `<name>@1.0.0` git tags or their
  `refs/notes/semantic-release-*` notes — the next run's get-last-release
  needs the tag+note pairs.
- If the merge itself must be abandoned before the workflow ran (or the
  workflow was still gated), revert the merge commit on `main`; nothing was
  published, so `alpha` is unaffected.

## 5. Remaining for a maintainer (sandbox couldn't verify)

- Real-token `--dry-run` through the shipped config (verifyConditions with
  actual npm + GitHub tokens) — pre-flight step 4.
- Observing the `prepare`-phase manifest writes (dependency/peer rewrites on
  disk) and the OIDC-provenance publish — only observable in the real run.
- `npm dist-tag` end-state and `lunora init` against the live registry —
  post-release steps 12–14.
- The alpha→main merge-conflict resolution itself (workflow file, plus
  whatever else diverged by then).
