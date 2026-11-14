# Plan 570 — `cloudflare ai-gateway --env <name>` writes the gateway vars where that environment reads them

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** DONE (APPROVED; PR #1568, branch fix/improve-570-ai-gateway-env)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/cli/src/commands/cloudflare/ai-gateway/handler.ts packages/cli/src/commands/cloudflare/handler.ts packages/cli/src/commands/cloudflare/index.ts packages/cli/__tests__/commands/cloudflare-ai-gateway.test.ts packages/cli/docs/index.mdx`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 29 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`lunora cloudflare ai-gateway` writes `LUNORA_AI_GATEWAY_ID` (and the account id var) only into the
top-level `vars` of `wrangler.jsonc` and accepts no `--env`. Wrangler does not inherit `vars` into
`env.<name>`: a Worker deployed with `--env staging` never sees the gateway id and silently routes
through the account's `default` gateway.

Verified against the installed `wrangler@4.156.2` (`wrangler-dist/cli.js`): `vars` is read with
`notInheritable(...)`, which returns only `env.<name>.vars` and, when the environment has none but
the top level does, warns `"vars" exists at the top level, but not on "env.<name>" … "vars" is not
inherited by environments`.

## 1. Current state (audit)

- `packages/cli/src/commands/cloudflare/ai-gateway/handler.ts`:
    - Lines 39-43 `interface WranglerAiShape { account_id?: unknown; name?: unknown; vars?: Record<string, unknown>; }`
    - Lines 51-62 `interface AiCommandOptions` (no `env`).
    - Lines 128-147 `writeVariables(text, current, entries)`, which calls
      `applyModify(next, ["vars", key], value)` for each changed key.
    - Lines 215-244 `resolveProject(options)` reads and parses the wrangler file.
    - Lines 264-322 `runAiGatewayCommand`: `const written = writeVariables(text, parsed.vars, variables);`
      then dry-run report, credentials, `ensureGateway`, `writeFileSync` and messages
      `"wrote … into ${wranglerPath} vars."` / `"vars are already up to date."`.
- `packages/cli/src/commands/cloudflare/handler.ts` line 114:
  `runAiGatewayCommand({ cwd, dryRun: options.dryRun === true, id: options.id, logger, logs: options.logs })`.
  Lines 141, 165 and 189 show `env: options.env` being passed to the other tools.
- `packages/cli/src/commands/cloudflare/index.ts` line 121: the group-level flag
  `{ description: "containers / deployments / profile: Cloudflare environment name", name: "env", type: String }`.
- `packages/cli/docs/index.mdx` lines 82-83: the usage line
  `lunora cloudflare ai-gateway [--id <id>] … [--no-logs] [--dry-run] [--format json]`.
- Tests: `packages/cli/__tests__/commands/cloudflare-ai-gateway.test.ts` (writes a `wrangler.jsonc`
  into a temp dir and runs `runAiGatewayCommand` with an injected `fetch` and `environment`).

## 2. Existing seams (do not reinvent)

`applyModify` (keeps comments and formatting), `readWranglerJsonc`, `fail(logger, code, message)`,
`EXIT_CODE.USAGE`.

## 3. The behavioural contract to preserve

Without `--env`, the file is written exactly as today. Existing tests pass. The `--format json`
payload keeps its fields; add `env` only if you need it (optional `env?: string`).

## 4. Design decisions

- Add `env?: string` to `AiCommandOptions` and `env?: Record<string, { vars?: Record<string, unknown> } | undefined>`
  to `WranglerAiShape`. Pass `env: options.env` from `cloudflare/handler.ts`.
- With `--env <name>`:
    - If `parsed.env?.[name]` is not an object, fail with `EXIT_CODE.USAGE` and
      `ai-gateway: wrangler.jsonc has no env.<name> block — check the name, or add the environment first.`
      Why: `applyModify` would otherwise silently create a new environment from a typo.
    - Read current values from `parsed.env[name].vars`, write with path `["env", name, "vars", key]`.
    - Messages say `env.<name>.vars` instead of `vars`.
- Without `--env`, when `parsed.env` has one or more environments, keep writing the top level and
  add ONE warning naming them: `ai-gateway: wrote the top-level vars only; wrangler does not inherit vars into environments — re-run with --env <name> for each of: staging, production`.
  Print it in dry run too.
- `writeVariables` gains a `path` prefix parameter (`["vars"]` or `["env", name, "vars"]`).
- Update the flag description in `index.ts` to `"containers / deployments / profile / ai-gateway: Cloudflare environment name"`, add an example line for `--env` beside lines 64-66 if that list is the command's examples, and add `[--env <name>]` to the docs usage line.
- **Rejected:** writing every environment automatically. Each environment may deliberately use a
  different gateway.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `cli`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                                    | Expected |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                           | exit 0   |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                                                 | exit 0   |
| Test files      | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/cloudflare-ai-gateway.test.ts __tests__/commands/cloudflare-group.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                                                     | all pass |
| Format code     | `pnpm exec oxfmt <each changed .ts file>`                                                                                                  | exit 0   |
| Format docs     | `pnpm exec prettier --write packages/cli/docs/index.mdx`                                                                                   | exit 0   |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                              | exit 0   |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                                               | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/cloudflare/ai-gateway/handler.ts`,
`packages/cli/src/commands/cloudflare/handler.ts`, `packages/cli/src/commands/cloudflare/index.ts`,
`packages/cli/__tests__/commands/cloudflare-ai-gateway.test.ts`, `packages/cli/docs/index.mdx`
(usage line only), and `packages/cli/__tests__/commands/cloudflare-group.test.ts` only if it pins
the flag description text.

**Out of scope:** per-environment `account_id` (a separate minor finding), the gateway id default,
`packages/ai/**`, `plans/README.md`.

### Git workflow

- Branch `fix/improve-570-ai-gateway-env`, from `origin/alpha`. Do not push.
- One commit: `fix(cli): write ai-gateway vars into the chosen wrangler env`; body ≤ 4 lines; last
  line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint; Prettier for the `.mdx`. No `.js` import extensions. Named exports only.
  Comments say why.
- No network in tests. No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without
  rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

In `cloudflare-ai-gateway.test.ts`, following its existing setup:

1. Config with `"env": { "staging": { "vars": { "KEEP": "1" } } }`, run with `env: "staging"` →
   the written file's `env.staging.vars` has `LUNORA_AI_GATEWAY_ID` and still has `KEEP`; top-level
   `vars` gains nothing.
2. Same config with `env: "staging"` and `dryRun: true` → file unchanged, `data.varsWritten` lists
   the key.
3. `env: "prod"` (not in the config) → exit code is `EXIT_CODE.USAGE`, the file is unchanged, and the
   message names `env.prod`.
4. No `env`, config with two environments → top-level vars written as today and a warning naming
   both environments.

**Verify:** test-file command → cases 1, 3 and 4 FAIL (case 2 may fail too).

### Step 3: Implement

Per section 4, including the handler pass-through, flag description and docs usage line.

**Verify:** test-files command passes.

### Step 4: Gates, then commit

**Verify:** both formatters, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/cli/src/commands/cloudflare/ai-gateway/handler.ts > packages/cli/src/commands/cloudflare/ai-gateway/handler.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/cloudflare-ai-gateway.test.ts   # new cases FAIL
git checkout HEAD -- packages/cli/src/commands/cloudflare/ai-gateway/handler.ts
git status --short   # empty
```

(Type errors from the reverted file are expected during this check; only the test outcome matters.)

## 6. Platform parity

Not applicable: no `ctx.*` surface; this writes Cloudflare-specific config only.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                   |
| ----- | --------- | ------------------------------------------------------ |
| 0     | Steps 1-5 | new cases red on base, green with fix; cli gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if `applyModify` cannot write a nested `["env", name, "vars", key]` path while keeping the
  existing keys (case 1 loses `KEEP`).
- **STOP** if the group-level `--env` flag is not delivered to the ai-gateway branch of
  `cloudflare/handler.ts` (check the options type there).

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New cases fail against `79b0c5a6a`'s `ai-gateway/handler.ts`.
- [ ] `grep -n "ai-gateway: Cloudflare environment name\|/ ai-gateway: Cloudflare" packages/cli/src/commands/cloudflare/index.ts` matches.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files.

## Maintenance notes

Any CLI command that writes `vars` must take `--env` for the same reason.
