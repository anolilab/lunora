# Plan 552 — Install the published packages after every release (post-release smoke)

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — needs npm, a published release and CI to verify; not dispatched)
**Priority / effort / risk:** P2 / S-M / LOW. **Category:** ci.

## 0. Headline finding

Nothing installs the packages the release job just published. `scripts/clean-machine-smoke.sh` scaffolds
a project from packed local tarballs (deliberately offline), and its own header says
"this script is in no workflow, so nothing here runs in CI" (line ~29). A broken `files` whitelist, a
missing `dist` entry, or a peer range that does not resolve on npm ships unnoticed until a user hits it.
`ROADMAP.md` "Next" lists "`lunora init` end-to-end against npm `latest`" as a 1.0 item.

## 1. Current state

- `scripts/clean-machine-smoke.sh` (root script `test:clean-machine`): packs `@lunora/cli`, runs
  `lunora init --from "$REPO_ROOT/templates"` then `lunora codegen` against tarballs. Header lines 18-27
  list what it does not cover: the remote giget fetch, booting the dev server, installing runtime deps
  from npm.
- `.github/workflows/semantic-release.yml` — job `release` (line ~32): build, verify, then
  `vis release ci release …` publishes and pushes tags; the last steps (~line 187) refresh a CodSpeed
  baseline. No step installs from the registry.

## 4. Design decisions (to settle when executed)

- A separate job `post-release-smoke` in `semantic-release.yml` with `needs: release`, running on the
  channel just published (`alpha` dist-tag on `alpha`, `latest` on `main`): in an empty temp dir,
  `npm create`-style `npx lunorash@<dist-tag> init <name> -t <template>` (the real giget fetch against
  the branch), `pnpm install` from the registry, `lunora codegen`, `tsc --noEmit`, and a build.
  Chosen over extending `clean-machine-smoke.sh` (its value is being offline and tree-local).
- Wait for registry propagation by polling `npm view <pkg>@<version> version` with a bounded retry
  (this is CI, not a test; a bounded poll is the only signal npm offers).
- Failure files/updates a tracking issue like `nightly.yml`'s `report-failure` job.

## 5. Workstreams

1. (S) Script `scripts/post-release-smoke.sh <dist-tag> <template>`: the steps above, `set -euo pipefail`,
   no reuse of the workspace (`cd "$(mktemp -d)"`), `npm_config_registry` default.
2. (S) Job in `semantic-release.yml`, one template per matrix leg (start with the template the docs'
   quickstart uses), `permissions: contents: read` plus `issues: write` for the reporter.
3. (S) Document in `.agents/docs/workflow.md` ("What the release does on a push") as step 4.

## 6. Platform parity

Not applicable.

## 7. Gates

| Phase | Gate                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ |
| 1     | `bash scripts/post-release-smoke.sh alpha <template>` passes locally against the current alpha release |
| 2     | jactionlint/zizmor clean on `semantic-release.yml`; first post-release run green                       |

## 8. Risks

- **Risk:** npm propagation lag makes the job flaky. Mitigate: poll `npm view` up to N minutes, fail
  with a clear message.
- **Risk:** the job must never be able to publish or push; give it read-only `contents`.
- **STOP** if the release job's trusted-publisher setup depends on the workflow's job list (renaming
  or reshaping `release` is out of scope; adding a job is not).

## 9. Open questions

1. Which templates are worth a leg on every release (cost vs. coverage)?
2. Should a red post-release smoke deprecate the just-published versions automatically? (Recommend no;
   open an issue.)
