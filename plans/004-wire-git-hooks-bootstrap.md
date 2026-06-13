# Plan 004: Make the committed git hooks actually run (wire core.hooksPath bootstrap) and fix the stale hook docs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- package.json CLAUDE.md .vis/hooks vis.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (one script hook + docs; worst case is a noisy install step)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

The repo's pre-commit chain (gitleaks-style secrets scan + staged
Prettier/ESLint) is fully configured but **does not run**: the committed hook
scripts live at `.vis/hooks/`, they only fire when `core.hooksPath` points at
the generated dispatcher `.vis/hooks/_`, and nothing committed to the repo sets
that config after a clone or install. The primary development checkout
demonstrates the failure: its `core.hooksPath` points at the default
`.git/hooks`, which contains only `*.sample` files — so secrets could be
committed and staged-lint feedback is deferred to CI. On top of that,
`CLAUDE.md` still documents the **previous** husky setup (".husky/pre-commit",
husky devDependency) which was migrated away in commit `27a80810`; agents
following those docs will look for files that don't exist.

## Current state

- `.vis/hooks/` — committed hook scripts: `pre-commit` (runs the chain),
  `commit-msg`, `post-commit`, `prepare-commit-msg`, `config.json`, plus the
  generated dispatcher dir `_/` (gitignored: `.gitignore` has `!/.vis/hooks/`
  and `.vis/hooks/_/`).
- History (for understanding, not for re-doing):
  - `27a80810` "chore: migrate git hooks from husky to vis hooks" — ran
    `vis hook migrate`, dropped the husky devDep + `prepare` script, pointed
    `core.hooksPath` at the dispatcher.
  - `d47716ed` "chore: adopt @visulima/vis alpha.34 tooling" — moved
    `.vis-hooks` → `.vis/hooks`, "reinstall so core.hooksPath points at
    .vis/hooks/_". That reinstall was a **manual, per-clone action** — that's
    the gap.
- `git config core.hooksPath` in this checkout currently prints the default
  `.git/hooks` path (hooks dead). `ls .git/hooks` shows only `*.sample`.
- `vis.config.ts:93-110` — the `staged` block (Prettier repo-wide, per-package
  ESLint) and `secrets.walk.excludePatterns`. Config is intact; only the git
  wiring is missing.
- Root `package.json` scripts: has `postinstall: "node scripts/generate-package-og-images.js"`;
  **no `prepare` script**; husky is **not** a devDependency (correct).
- `CLAUDE.md` "Pre-commit Hooks" section (stale — to be rewritten):

```markdown
### Pre-commit Hooks

Husky drives two `@visulima/vis` commands on commit (configured in `vis.config.ts`):

- `vis secrets --staged` — gitleaks-compatible scan over staged files; excludes from `secrets.walk.excludePatterns`.
- `vis staged` — runs the per-glob commands declared in the top-level `staged` block (Prettier + ESLint on code, Prettier on Markdown).

Hook chain (`.husky/pre-commit`) uses `set -e`, so a secret detection aborts before staged-file linting runs.
```

- The vis CLI is available via `pnpm exec vis`. The exact hook-install
  subcommand must be discovered in Step 1 (the migration commit used
  `vis hook migrate` and `vis hook validate`; an install/reinstall variant is
  expected to exist).

## Commands you will need

| Purpose            | Command                                    | Expected on success |
|--------------------|--------------------------------------------|---------------------|
| Install            | `pnpm install`                             | exit 0              |
| Discover hook CLI  | `pnpm exec vis hook --help`                | lists subcommands   |
| Validate hooks     | `pnpm exec vis hook validate` (if present) | exit 0              |
| Check wiring       | `git config core.hooksPath`                | `.vis/hooks/_`      |

## Scope

**In scope** (the only files you should modify):
- `package.json` (root — add a `prepare` script)
- `CLAUDE.md` (rewrite the "Pre-commit Hooks" section)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- `.vis/hooks/*` scripts and `config.json` — they are correct; this plan only
  wires them up.
- `vis.config.ts` — the staged/secrets config is correct.
- `.github/workflows/*` — CI gating is plan 005's territory (pnpm versions)
  and otherwise out of scope.
- Re-introducing husky — the repo deliberately migrated off it.

## Git workflow

- Branch: `dx/wire-git-hooks` off `alpha`.
- Conventional commit, e.g. `dx: bootstrap vis git hooks on install` (imperative, lowercase, ≤50 chars).
- Do NOT push or open a PR unless the operator instructed it.
- Note: until this plan lands, committing won't trigger hooks anyway; after
  wiring them, your own commit will exercise the chain — that's expected and
  is itself a verification.

## Steps

### Step 1: Discover the vis hook-install command

Run `pnpm exec vis hook --help`. Identify the subcommand that (re)generates
the `_/` dispatcher and sets `core.hooksPath` (candidates: `install`,
`reinstall`, or `migrate`'s idempotent mode). Run it once manually.

**Verify**: `git config core.hooksPath` → a path ending in `.vis/hooks/_`, and
`ls .vis/hooks/_/` shows hook proxies (`pre-commit` among them).

If no subcommand sets up the dispatcher, STOP and report the actual `--help`
output.

### Step 2: Wire it into install

Add to root `package.json` scripts (keep alphabetical ordering of the scripts
block — it is currently alphabetized):

```json
"prepare": "vis hook install"
```

(using the actual subcommand discovered in Step 1; `prepare` runs automatically
on `pnpm install` in the workspace root and NOT for published consumers — that
is the standard slot for hook bootstrap.)

**Verify**: unset the wiring (`git config --unset core.hooksPath`), run
`pnpm install`, then `git config core.hooksPath` → `.vis/hooks/_` again.
Also confirm `pnpm install` still exits 0 and the OG-image postinstall still
runs (its output or exit status unchanged).

### Step 3: Prove the chain fires

Stage a trivial whitespace-violating change to any `.md` file (e.g. add a
double space at a line end somewhere in `VOID-TEARDOWN.md`), run
`git commit -m "wip: hook smoke"` and observe the hook output (the pre-commit
script echoes "Starting Git hook: pre-commit"). Then **reset**: `git reset HEAD~1`
if it committed, or unstage — leave no smoke-test commit in history (amend it
away or reset before your real commit).

**Verify**: hook banner appeared in the commit output; secrets scan + staged
lint ran.

### Step 4: Fix CLAUDE.md

Rewrite the "Pre-commit Hooks" section to describe reality:

- Hooks are **vis-native** (no husky): committed scripts in `.vis/hooks/`,
  generated dispatcher in `.vis/hooks/_/` (gitignored), wired via
  `core.hooksPath` by the root `prepare` script on `pnpm install`.
- The pre-commit chain still runs `vis secrets --staged` then `vis staged`
  (`set -e`, so a secret detection aborts before lint).
- One line for recovery: "if hooks aren't firing, run `pnpm exec vis hook <subcommand>`".

Keep the section heading "### Pre-commit Hooks" so links/anchors survive.

**Verify**: `grep -n "husky\|.husky" CLAUDE.md` → no remaining references
(check the whole file, not just this section — the word may appear elsewhere).

## Test plan

No unit tests — verification is the live hook firing (Step 3) plus the
machine checks below. There is nothing to add to a Vitest suite for git
wiring.

## Done criteria

- [ ] `git config core.hooksPath` → ends in `.vis/hooks/_`
- [ ] Fresh-wire simulation passes: `git config --unset core.hooksPath && pnpm install && git config core.hooksPath` → `.vis/hooks/_`
- [ ] A staged commit shows the pre-commit hook banner (observed in Step 3)
- [ ] `grep -rn "husky" CLAUDE.md package.json` → no matches
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `vis hook --help` exposes no install/reinstall-like subcommand (Step 1).
- The vis hook installer wants to overwrite/regenerate the **committed**
  scripts in `.vis/hooks/` with different content (diff appears in `git status`
  beyond the gitignored `_/` dir).
- `prepare` causes `pnpm install` failures in CI-like environments (e.g. the
  vis binary not yet linked when `prepare` runs) — report the ordering problem
  instead of moving the call to `postinstall` on your own.
- The pre-commit chain fails on the repo's *current* staged state for reasons
  unrelated to your change (pre-existing lint/secret findings) — report them.

## Maintenance notes

- Future vis upgrades that change the hook dispatcher layout will need the
  `prepare` script revisited (commit `d47716ed` is precedent: an upgrade moved
  the directory and silently orphaned every clone's wiring — exactly what this
  plan fixes).
- Reviewer should scrutinize: that `prepare` is the right lifecycle slot under
  the repo's pnpm version (root-only execution, runs on `pnpm install`), and
  that CI is unaffected (CI doesn't commit, so hooks are irrelevant there, but
  the `prepare` script still executes during CI installs — it must be fast and
  non-interactive).
- The user-memory/docs claim that "husky drives the hooks" appears in multiple
  agent-facing docs; this plan fixes CLAUDE.md only. If other docs mention
  husky (`grep -rn husky docs/ apps/docs/ 2>/dev/null`), list them in your
  report as follow-ups; do not edit them here.
