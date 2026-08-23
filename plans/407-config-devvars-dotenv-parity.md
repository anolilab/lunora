# Plan 407: Make the `.dev.vars` reader parse what wrangler's dotenv parser parses

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/config/src/dev-variables-format.ts packages/config/src/studio-host/admin-token.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security | bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`@lunora/config`'s `.dev.vars` grammar claims to read "the same file `@cloudflare/vite-plugin` / `wrangler dev` feed the worker" (`admin-token.ts:19-24`), but wrangler parses `.dev.vars` with **dotenv** (verified in the installed `wrangler@4.120.1`: `wrangler-dist/cli.js` `tryLoadDotDevDotVars` → `import_dotenv3.default.parse(contents)`), while Lunora hand-rolls a stricter split. Any line dotenv accepts but Lunora drops (or reads differently) means: the studio embeds an admin token the worker never saw → every admin RPC 401s with no explanation; and `lunora env doctor` / the deploy secret gate report a secret as _missing_ that is actually set, offering to mint a replacement.

Known divergences (dotenv `LINE` regex, `dotenv@16.6.1/lib/main.js:9`, vs `splitDevVariableLine`):

1. `export FOO=x` — dotenv strips `export `; Lunora drops the line (key `export FOO` fails `DEV_VARS_KEY_PATTERN`).
2. `FOO.BAR=x` / `FOO-BAR=x` — dotenv keys are `[\w.-]+`; Lunora rejects.
3. `FOO=x # note` — dotenv yields `x` (unquoted value stops at `#`); Lunora yields `x # note`.
4. `FOO="a\nb"` — dotenv expands `\n`/`\r` inside double quotes; Lunora yields the literal backslash-n.
5. `FOO: value` — dotenv accepts the colon separator; Lunora drops the line.
6. Backtick-quoted and multi-line quoted values — dotenv supports both (its regex runs multiline over the whole file); Lunora splits on newlines first and drops/mangles them.

## Current state

- `packages/config/src/dev-variables-format.ts` — the single owner of the grammar (its own doc: "one owner, shared by every reader/writer of the file"). Key parts:
    - `:17` `const DEV_VARS_KEY_PATTERN: RegExp = /^[A-Za-z_]\w*$/u;`
    - `:23-29` `unquoteDevVariable` strips one layer of matching single/double quotes (no backticks, no escape expansion).
    - `:36-56` `splitDevVariableLine` — trims, drops `#`-leading and blank lines, splits at the first `=`, validates the key against `DEV_VARS_KEY_PATTERN`, returns the trimmed remainder verbatim.
- `packages/config/src/studio-host/admin-token.ts:26-38` — `resolveAdminToken` reads `LUNORA_ADMIN_TOKEN` through this grammar.
- Consumers of the grammar: `grep -rn "parseDevVariable\|splitDevVariableLine\|parseDevVariableEntries" packages/config/src packages/cli/src` — the CLI `env` command and the deploy secret gate route through here. The **writer** (`upsertDevVariableLine` / the scaffolder's comment-preserving rewrite) also lives in `dev-variables-format.ts` — its output format must not change.
- Wrangler's parser (installed tree, for reference only — do not import from it): `node_modules/.pnpm/wrangler@4.120.1*/node_modules/wrangler/wrangler-dist/cli.js:255407-255427` parses via dotenv. `dotenv` versions `16.6.1` and `17.4.2` are both already in the lockfile.

## Commands you will need

| Purpose               | Command                                          | Expected on success |
| --------------------- | ------------------------------------------------ | ------------------- |
| Install               | `pnpm install`                                   | exit 0              |
| Build deps            | `pnpm --filter "@lunora/config..." run build`    | exit 0              |
| Tests (config)        | `pnpm --filter "@lunora/config" run test`        | all pass            |
| Tests (cli, consumer) | `pnpm --filter "@lunora/cli" run test`           | all pass            |
| Typecheck             | `pnpm --filter "@lunora/config" run lint:types`  | exit 0              |
| Lint                  | `pnpm --filter "@lunora/config" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/config/src/dev-variables-format.ts` (reader functions only)
- `packages/config/__tests__/` — the existing dev-variables test file (extend)
- `packages/config/package.json` **only if** you take the dotenv-dependency route (see Step 1) — then also `pnpm-workspace.yaml` is NOT to be touched (dotenv already resolves; use the version the catalog/lockfile already carries; if no catalog entry exists, STOP and report).

**Out of scope**:

- The writer path: `upsertDevVariableLine`, the scaffolder's line-preserving rewrite, `DEV_VARS_KEY_PATTERN` as writer-side validation. The writer keeps emitting the strict `KEY=value` form.
- `packages/cli` source (consumers pick the change up through the shared module).
- Wrangler/node_modules anything.

## Git workflow

- Branch: `improve/wave22-config`
- Commit: `fix(config): parse .dev.vars with dotenv semantics`
- Commit body must note the behaviour change: lines previously dropped (export-prefixed, dotted keys) are now read; unquoted values now stop at `#`.

## Steps

### Step 1: Replace the reader's line-splitting with dotenv-compatible parsing

Preferred (ladder): use the `dotenv` package's `parse()` directly — it is already in the lockfile and is literally what wrangler runs. Check whether `@lunora/config` may depend on it: `grep -n '"dotenv"' packages/config/package.json pnpm-workspace.yaml`. If a catalog entry exists (or another workspace package already depends on it directly), add `"dotenv": "catalog:<name>"` (or the exact convention used elsewhere) to `packages/config/package.json` dependencies and implement `parseDevVariableEntries` on top of `parse()`, preserving the current return shape (`{ key, value }[]` in file order — note dotenv's `parse` returns an object; to preserve file order and duplicate-last-wins semantics, iterate `Object.entries`, which for string keys preserves insertion order and matches dotenv's overwrite behaviour).

If no clean dependency route exists, port dotenv's `LINE` regex and value handling (trim → strip matching `'"` \` quotes → expand `\n`/`\r` in double-quoted values) into `dev-variables-format.ts` with a comment citing dotenv 16.6.1 as the reference implementation.

Keep `parseDevVariable(content, key)`'s signature unchanged.

**Verify**: `pnpm --filter "@lunora/config" run lint:types` → exit 0.

### Step 2: Fixture table of divergent line shapes

Add to the existing dev-variables test file a table-driven test over at least these inputs, asserting the parsed result equals what wrangler/dotenv would produce:

| line                             | expected key | expected value                                  |
| -------------------------------- | ------------ | ----------------------------------------------- |
| `export FOO=x`                   | `FOO`        | `x`                                             |
| `FOO.BAR=x`                      | `FOO.BAR`    | `x`                                             |
| `FOO=x # note`                   | `FOO`        | `x`                                             |
| `FOO="a\nb"`                     | `FOO`        | `a<newline>b`                                   |
| `FOO: colon`                     | `FOO`        | `colon`                                         |
| `` FOO=`tick` ``                 | `FOO`        | `tick`                                          |
| `FOO="multi` + newline + `line"` | `FOO`        | `multi\nline` (real newline)                    |
| `# comment=notakey`              | (dropped)    |                                                 |
| `FOO='keep\n'`                   | `FOO`        | `keep\n` (literal — single quotes don't expand) |

**Verify**: `pnpm --filter "@lunora/config" run test` → all pass.

### Step 3: Writer round-trip stays intact

Run the existing writer/scaffolder tests unchanged. The writer still emits `KEY=value` with `DEV_VARS_KEY_PATTERN` validation — only the reader loosened.

**Verify**: `pnpm --filter "@lunora/config" run test` and `pnpm --filter "@lunora/cli" run test` → all pass with **no writer-test modifications**.

## Test plan

- The fixture table above (9+ cases) in the existing dev-variables test file (find it: `grep -rln "splitDevVariableLine\|parseDevVariable" packages/config/__tests__`).
- One regression: `resolveAdminToken` reads a token from `export LUNORA_ADMIN_TOKEN=abc # local` as `abc`.

## Done criteria

- [ ] `pnpm --filter "@lunora/config" run test` exits 0 incl. the new fixture table
- [ ] `pnpm --filter "@lunora/cli" run test` exits 0 with no writer-test edits
- [ ] `pnpm --filter "@lunora/config" run lint:types` and `lint:eslint` exit 0
- [ ] If package.json changed: `pnpm run lint:package-json` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- Making the reader dotenv-compatible forces changes to the writer's output format or breaks the scaffolder's comment-preserving round-trip tests.
- `dotenv` has no existing catalog entry AND porting the regex is blocked by some structure in `dev-variables-format.ts` you'd have to rewrite wholesale.
- You find a consumer that depends on the old strict behaviour on purpose (e.g. a test asserting `export FOO=x` is _rejected_ with a rationale comment).

## Maintenance notes

- If wrangler ever changes its `.dev.vars` parser (watch its changelog for dotenv major bumps), the fixture table is the tripwire — extend it rather than the implementation first.
- Reviewer: confirm the writer emits nothing the new reader would reinterpret (quotes containing `#`, values starting with `export `).
