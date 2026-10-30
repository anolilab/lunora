# Repo workflow

Git hooks, the release pipeline, and the internal scaffolding generators.
Read it when you are adding a package/function/table, debugging a hook, or
touching release config — not for ordinary code changes.

## Pre-commit Hooks

Git hooks are **vis-native** (no husky). Committed scripts live in `.vis/hooks/`, run via a generated dispatcher at `.vis/hooks/_/` (gitignored); the root `prepare` script (`vis hook install`) wires `core.hooksPath` on every `pnpm install`. The pre-commit stage runs (via `vis.config.ts`, `set -e`):

- `vis secrets --staged` — gitleaks-compatible scan over staged files (aborts before linting on detection).
- `vis staged` — per-glob commands from the top-level `staged` block (Prettier + ESLint on code, Prettier on Markdown).

If hooks aren't firing, run `pnpm exec vis hook install` (or `vis hook validate` to diagnose).

**Order matters when fixing by hand: Prettier first, then ESLint.** `prettier --write` followed by `eslint --fix`. The reverse order lets Prettier reformat lines ESLint just fixed and reintroduce the violations.

## Release

Independent per-package versioning via `vis release` — the `release` block in `vis.config.ts` is the whole configuration; there is no per-package release file. Conventional Commits drive bumps; `.github/workflows/semantic-release.yml` publishes on push to `alpha` / `main` / `next` / `beta`. Do not author `release` commits manually.

The workflow keeps its filename because npm's trusted publishers are registered against `semantic-release.yml` for every package — renaming it breaks publishing until all 57 entries are updated.

### What the release does on a push

1. The job checks out the branch tip and resolves the baseline: this channel's last release tag (`git describe --match`), or the `base` dispatch input. Not `github.event.before`: a burst of merges during a release cancels every queued run but the last. A channel with no tag yet fails; dispatch with `base`.
2. `vis release ci release --auto-publish --generate --generate-from <baseline>` writes one change file per package, versions, pushes ONE `chore(release)` commit (rebased and retried up to `pushRetries` when the branch moved), then publishes and pushes the tags. Tags point at the planned commit (`tagTarget: "source"`), so a rebased release commit never strands them. Versions an earlier run left unpublished are published first (`--publish-missing`, on by default). One branch push and one tag push per run; one concurrency group for all release branches.
3. Released PRs and issues get a comment and the `released` label (`successWalk`).

Locally: `vis release status --channel alpha` prints the pending plan, `vis release publish --dry-run` the dist-tag and versions it would publish, and `vis release doctor` checks the setup.

### Rules the release depends on

- **`internalDependencyRanges: "preserve-satisfying"`.** Without it vis rewrites `>=1.0.0-alpha.76 <2.0.0-0` to `>=<new version>` (no ceiling). `scripts/check-sibling-peer-ranges.js` fails the install on a sibling peer range without an upper bound, and if `updateInternalDependencies: "out-of-range"` disappears.
- **`ignoreCommitPattern` limits releases to feat / fix / perf / revert / breaking**, as before. vis maps every other conventional type to a patch; breaking commits bypass the pattern.
- **`release.changelog` points at `scripts/vis-changelog-format.js`.** `apps/docs` parses `packages/*/CHANGELOG.md` for its changelog feed and needs the semantic-release heading shape plus `### Features` / `### Dependencies` sections.

## Internal scaffolding (`vis generate`)

Adding a query/mutation/action/table/cron to `lunora/`, or a fresh `@lunora/<name>` package, is done with `vis generate` (templates at `.vis/templates/lunora-*.ts`). There is no `lunora new` subcommand.

```bash
vis generate lunora-query --name=listMessages              # → lunora/listMessages.ts
vis generate lunora-mutation --name=sendMessage
vis generate lunora-action --name=syncWithStripe
vis generate lunora-http-route --name=stripeWebhook        # → lunora/stripeWebhook.ts (HTTP route)
vis generate lunora-table --name=invoices                  # AST-merges into lunora/schema.ts
vis generate lunora-cron --name='clear presence'           # AST-appends to lunora/crons.ts
vis generate lunora-container --name=transcoder            # → lunora/containers.ts + Dockerfile, wires worker entry
vis generate lunora-workflow --name=orderPipeline          # appends to lunora/workflows.ts, wires worker entry
vis generate lunora-queue --name=emailQueue                # producer + queue() consumer
vis generate lunora-step --name=chargeOrder                # reusable defineStep, run via ctx.runStep
vis generate lunora-agent --name=support                   # defineAgent, appends to lunora/agents.ts (@lunora/agent)
vis generate lunora-flags                                  # → lunora/flags.ts singleton (@lunora/flags); refuses if it exists
vis generate lunora-auth-do                                # → lunora/auth-do.ts singleton (DO-backed auth mode); refuses if it exists
vis generate lunora-collections                            # → lunora/collections.ts (@lunora/db)
vis generate lunora-package --name=foo --description='…'   # → packages/foo/
vis generate --list                                         # list all generators
```

**`--name` flag:** vis parses space-separated `--name listMessages` as `--name=true` + a stray positional. **Always use `--name=value`** (same for any string option on `vis generate`).

End-user scaffolding (`lunora init`) is unaffected — it fetches whole-project templates remotely via `giget` from `gh:anolilab/lunora/templates/<type>#alpha`.

