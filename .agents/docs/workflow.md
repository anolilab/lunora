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

Independent per-package versioning via `multi-semantic-release`. Publishable packages ship a `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`. Conventional Commits drive bumps; the `semantic-release.yml` workflow publishes on push to `alpha` / `main` / `next` / `beta`. Do not author `release` commits manually.

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

