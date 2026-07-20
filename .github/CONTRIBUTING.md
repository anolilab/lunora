# Contributing to Lunora

Thanks for being here. Lunora is **v0.1-alpha** and we triage issues + PRs against the [`alpha`](https://github.com/anolilab/lunora/tree/alpha) branch.

This guide covers what you need to hack on the monorepo. By participating you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js** `^22.15.0 || >=24.11.0` (see [`.nvmrc`](../.nvmrc); `nvm use` works).
- **pnpm** as pinned in [`package.json`](../package.json)'s `packageManager` field. Enable corepack (`corepack enable`) and it picks up that version automatically.
- **A Cloudflare account.** The free tier is fine. You only need one for running workerd integration tests against your own resources — local unit tests do not require an account.
- Git, a recent shell, and the usual.

## Repo setup

```bash
git clone git@github.com:anolilab/lunora.git
cd lunora
pnpm install
pnpm test          # all packages, vitest, parallel via @visulima/vis
pnpm lint:types    # tsc --noEmit across the workspace
```

If something explodes during install, double-check pnpm version and Node version first — those two cover 80 % of fresh-clone failures.

## Branching

- `alpha` — **primary development branch and the PR target.** Default branch on GitHub.
- `main` — stable releases (empty / quiet during the alpha window).
- `next`, `beta` — pre-release channels (unused during alpha).
- Feature branches: `feat/<short-name>`, `fix/<issue-number-or-slug>`, `docs/<area>`, `chore/<short-name>`.

Open your PR against `alpha`. Maintainers will rebase / squash on merge.

## Commit convention

We use [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint via [`commitlint.config.cjs`](../commitlint.config.cjs) (extending `@anolilab/commitlint-config`).

```
<type>(<scope>): <short summary>
```

Allowed `<type>` values:

| type       | use it for                                                           |
| ---------- | -------------------------------------------------------------------- |
| `feat`     | A new user-facing feature.                                           |
| `fix`      | A bug fix.                                                           |
| `perf`     | A performance improvement with no behaviour change.                  |
| `docs`     | Docs-only changes (README, JSDoc, package READMEs).                  |
| `dx`       | Developer-experience changes (scripts, generators, dev tooling).     |
| `refactor` | Internal restructure with no observable behaviour change.            |
| `test`     | Adding or fixing tests.                                              |
| `workflow` | GitHub Actions / repo automation changes.                            |
| `build`    | Build pipeline / tsup / bundler / output config.                     |
| `ci`       | CI plumbing not covered by `workflow`.                               |
| `chore`    | Anything that doesn't fit and doesn't ship to users.                 |
| `types`    | Type-only changes (`.d.ts`, generic parameters, etc.).               |
| `wip`      | Work-in-progress (squashed away before merge).                       |
| `release`  | Release commits created by `multi-semantic-release` — do not author. |
| `deps`     | Dependency updates (mostly Renovate / Dependabot).                   |
| `revert`   | Reverting a previous commit.                                         |

`<scope>` is the package name minus the `@lunora/` prefix. Examples:

```
feat(lunora-auth): add OAuth PKCE provider for github
fix(lunora-runtime): correct ws subprotocol negotiation
docs(lunora-d1): document migration runner ordering
chore(deps): bump vitest to 3.2.4
```

Subject line: imperative, lowercase, no trailing period, ≤ 50 characters where you can. Breaking changes get a `!` after the scope (`feat(lunora-server)!: ...`) and a `BREAKING CHANGE:` footer.

## Testing

```bash
# Whole workspace
pnpm test
pnpm test:affected     # only projects touched since main

# One package
pnpm --filter "@lunora/runtime" test
pnpm --filter "@lunora/runtime" test:coverage
```

Tests run on **vitest** with mocked `DurableObjectState` / `D1Database` by default — fast, no Cloudflare account needed.

For real-runtime integration tests against `workerd` + Miniflare, set the opt-in environment flag:

```bash
LUNORA_WORKERD_TESTS=1 pnpm test
```

`LUNORA_WORKERD_TESTS` is opt-in because the workerd pool is slower and currently only meaningful for `@lunora/runtime` and `@lunora/do`. Most contributions don't need it; CI runs both modes.

## Linting and types

```bash
pnpm lint:eslint        # all
pnpm lint:eslint:fix
pnpm lint:prettier
pnpm lint:prettier:fix
pnpm lint:types         # tsc --noEmit
```

Pre-commit hooks (Husky + `vis staged` / `vis secrets`, configured in the `staged` and `secrets` blocks of [`vis.config.ts`](../vis.config.ts)) run Prettier, ESLint, and a secrets scan on staged files. Don't `--no-verify` past them.

## Adding a new package

1. Pick the closest existing package to copy from (`packages/runtime/` is a good template for runtime code; `packages/values/` for pure utility libs).
2. Copy it into `packages/<name>/` and rename:
    - `package.json` → set `"name": "@lunora/<name>"`, clear `version`/`description`, update keywords.
    - `project.json` → update `"name"`, `"sourceRoot"`, and vis tags. Every package gets `type:package` and a `category:<slug>` tag (see [`AGENTS.md`](../AGENTS.md) for the categories).
    - `README.md` → write a 4–8 line description plus a minimal example.
3. Run `pnpm install` from the repo root so pnpm picks up the new workspace project.
4. Add a Vitest config under `vitest.config.ts` extending the workspace helper.
5. Reference shared deps via [pnpm catalogs](../pnpm-workspace.yaml) — `catalog:test`, `catalog:lint`, `catalog:tsc`, etc. Never hard-code a version that already lives in a catalog.

## Release process

Releases run on **`multi-semantic-release`** triggered by `.github/workflows/semantic-release.yml` on pushes to `alpha` (and later, `main` / `next` / `beta`).

You don't tag, you don't bump versions, you don't author `release` commits. Conventional Commits drive the version bumps; the workflow generates changelogs and publishes per-package.

Until a package has been wired with its own `.releaserc.json` (extending `@anolilab/semantic-release-preset/pnpm`), it is **not** published — early alpha packages are intentionally held back.

## Help

Open a [Discussion](https://github.com/anolilab/lunora/discussions) for questions, an [Issue](https://github.com/anolilab/lunora/issues/new/choose) for bugs / features, or email `d.bannert@anolilab.de` for anything sensitive.
