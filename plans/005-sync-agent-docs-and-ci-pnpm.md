# Plan 005: Sync agent-facing docs and CI with reality (package table, pnpm versions)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- CLAUDE.md README.md .github/workflows package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs + CI version pins)
- **Depends on**: none (plan 004 also edits CLAUDE.md — coordinate by executing 004 first or rebasing)
- **Category**: docs
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

CLAUDE.md is the ground truth injected into every AI-agent session in this
repo, and it has drifted: its package table lists 18 packages while
`packages/` contains 27 — `@cirrus/astro`, `@cirrus/mcp`, `@cirrus/ratelimit`,
`@cirrus/solid`, `@cirrus/studio`, `@cirrus/svelte`, `@cirrus/testing`,
`@cirrus/vectors`, and `@cirrus/vue` are undocumented, so agents plan work
without knowing they exist. Separately, three different pnpm versions are
claimed: CLAUDE.md says "pnpm v10.32.1 (enforced)", `package.json` declares
`"packageManager": "pnpm@11.5.3"`, and the GitHub workflows pin
`pnpm/action-setup` to `version: "11.3.0"` — so CI resolves dependencies with
a different pnpm than the one the lockfile was written with.

## Current state

- `packages/` directories (27): advisor, ai, astro, auth, cli, client,
  codegen, config, d1, db, do, mail, mcp, ratelimit, react, runtime,
  scheduler, server, solid, storage, studio, svelte, testing, values, vectors,
  vite, vue.
- `CLAUDE.md` package table (under "### Packages"): 18 rows
  (`grep -c '^| .@cirrus' CLAUDE.md` → 18). Missing the 9 named above.
- `CLAUDE.md` "Repository Overview": `**Package manager**: pnpm v10.32.1 (enforced).`
- Root `package.json:85`: `"packageManager": "pnpm@11.5.3"`; `engines.pnpm`: `">=10.32.1"`.
- `README.md`: contains a pnpm badge/mention of 10.32.1 (verify with
  `grep -n "10.32" README.md`).
- `.github/workflows/*.yml`: multiple `pnpm/action-setup` steps with
  `"version": "11.3.0"` (e.g. `lint.yml:41-43`, and repeated ~5× per file;
  enumerate with the grep in Step 3).
- Facts about the 9 missing packages (verify each against the package's
  `package.json` `description` and README before writing the row — these are
  drafts, not gospel):
  - `@cirrus/astro` — Astro integration: server helpers + preloaded-query hydration (`packages/astro/src`: `server.ts`, `worker.ts`).
  - `@cirrus/mcp` — MCP server exposing deployment introspection to AI agents (list functions/tables, run query/mutation/action).
  - `@cirrus/ratelimit` — rate limiting (token-bucket style; surfaced in react via `useRateLimit`).
  - `@cirrus/solid` — SolidJS binding: `createQuery`/`createMutation` + provider, preloaded hydration.
  - `@cirrus/studio` — the studio admin UI (table browser, SQL tab, advisors, logs, auth/sessions, vectors) embedded by CLI/Vite via `@cirrus/config`'s studio-host.
  - `@cirrus/svelte` — Svelte binding: `query`/`mutation` stores + context, preloaded hydration.
  - `@cirrus/testing` — unified test-helper entry point; currently re-exports `@cirrus/mail/testing` only (placeholder for a broader testing story).
  - `@cirrus/values` — already in the table; do not duplicate.
  - `@cirrus/vectors` — vector index helpers (studio has a vector index browser; verify role in `packages/vectors/src`).
  - `@cirrus/vue` — Vue binding: `useQuery`/`useMutation` + provider, preloaded hydration.

## Commands you will need

| Purpose         | Command                                              | Expected on success    |
|-----------------|------------------------------------------------------|------------------------|
| Table count     | `grep -c '^| .@cirrus' CLAUDE.md`                    | 27 after the fix       |
| Version sweep   | `grep -rn "10.32.1\|11.3.0" CLAUDE.md README.md .github/workflows/` | no stale hits after fix |
| Prettier        | `pnpm exec prettier --check CLAUDE.md README.md`     | exit 0                 |
| CI lint (local) | none — workflow YAML is checked by inspection        | —                      |

## Scope

**In scope** (the only files you should modify):
- `CLAUDE.md` (package table rows + pnpm version line)
- `README.md` (pnpm version mentions/badge only)
- `.github/workflows/*.yml` (only the `pnpm/action-setup` `version:` values)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- `package.json` `packageManager`/`engines` — 11.5.3 is the source of truth;
  everything else converges TO it.
- Any other workflow content (steps, caching, triggers).
- Per-package READMEs.
- The CLAUDE.md "Pre-commit Hooks" section — plan 004 owns it.

## Git workflow

- Branch: `docs/sync-claude-md` off `alpha`.
- Conventional commits, e.g. `docs: add 9 missing packages to the agents table`
  and `ci: align pnpm action-setup with packageManager` (imperative, lowercase, ≤50 chars).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Verify and write the 9 package rows

For each of the 9 packages: read `packages/<name>/package.json` (the
`description` field) and skim `packages/<name>/src/index.ts` exports. Write a
table row matching the existing table's voice (terse role description; see the
`@cirrus/vite` row as the tone exemplar). Insert rows keeping the table's
existing order convention (it is currently grouped roughly by layer, not
alphabetical — match by judgment: bindings near `@cirrus/react`, `studio`
near `advisor`, `testing` near `mail`).

**Verify**: `grep -c '^| .@cirrus' CLAUDE.md` → 27.

### Step 2: Fix the pnpm version claims in docs

- CLAUDE.md "Repository Overview": `pnpm v10.32.1` → `pnpm v11.5.3`.
- README.md: update any 10.32.1 badge/mention to 11.5.3.

**Verify**: `grep -rn "10.32" CLAUDE.md README.md` → no matches.

### Step 3: Align CI pnpm

Enumerate: `grep -rn '"version": "11.3.0"' .github/workflows/`. Replace each
with `"version": "11.5.3"`. Touch nothing else in the workflow files.

**Verify**: `grep -rn '11.3.0' .github/workflows/` → no matches;
`git diff --stat` shows only `version` lines changed in workflows
(`git diff .github/workflows/ | grep '^[+-]' | grep -v '^[+-][+-]'` shows only
version lines).

### Step 4: Format gate

**Verify**: `pnpm exec prettier --check CLAUDE.md README.md` → exit 0 (run
`--write` first if needed).

## Test plan

No unit tests — documentation and CI pins. The greps in Done criteria are the
machine checks. CI itself validates the workflow change on the next push.

## Done criteria

- [ ] `grep -c '^| .@cirrus' CLAUDE.md` → 27
- [ ] `grep -rn "10.32" CLAUDE.md README.md` → no matches
- [ ] `grep -rn "11.3.0" .github/workflows/` → no matches
- [ ] `pnpm exec prettier --check CLAUDE.md README.md` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A package's actual role contradicts the draft description in a way you
  can't resolve from its README/exports (write the row you CAN verify, flag
  the rest).
- The workflows pin 11.3.0 with an adjacent comment explaining WHY (a
  deliberate hold-back, like the `@cloudflare/vite-plugin` pin in
  `pnpm-workspace.yaml`) — do not override a documented pin; report it.
- `packageManager` in `package.json` is no longer 11.5.3 (converge on
  whatever it now says instead, and say so in your report).

## Maintenance notes

- The table will drift again; consider (follow-up, not this plan) a CI check
  comparing `ls packages/` against the table count.
- Reviewer should scrutinize: the 9 new role descriptions for accuracy —
  wrong docs are worse than missing docs, and this file steers every agent
  session.
