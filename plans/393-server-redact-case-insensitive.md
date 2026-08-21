# Plan 393: Make `redactSecrets`' key heuristic match camelCase and lowercase secret keys

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/server/src/env.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED (over-redaction changes some diagnostic text; safe direction)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`redactSecrets` is exported public API whose docstring says to "call it before logging anything derived from `env`, request bodies, or thrown errors" (env.ts:136-137). The keyed-value pass matches `password: hunter2` and `apiToken=abc` (the `KEYED_VALUE` regex captures any identifier key), but then tests the key against `SECRET_KEY = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u` — uppercase-only. So exactly the spellings that appear in request bodies and thrown errors (`password`, `apiToken`, `authSecret`) fall through unredacted; the value-shape heuristics only catch them with a known prefix or ≥24 chars of entropy. A short app password logged from a request body goes out in the clear. Note the existing uppercase regex also matches `MONKEY=` (ends in `KEY`) — the fix below adds proper boundaries rather than blindly adding `/i`, which would extend that false-positive class to every English word ending in "key".

## Current state

- `packages/server/src/env.ts:101`:
  ```ts
  const SECRET_KEY = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;
  ```
- `packages/server/src/env.ts:118-119`:
  ```ts
  const KEYED_VALUE = /\b(?<key>[A-Za-z_]\w*)\s*[=:]\s*\S+/gu;
  ```
- `packages/server/src/env.ts:155-159` — the pass:
  ```ts
  out = out.replaceAll(KEYED_VALUE, (match, ...groups) => {
      const named = groups.at(-1) as { key?: string } | undefined;
      return named?.key !== undefined && SECRET_KEY.test(named.key) ? `${named.key}=${REDACTED}` : match;
  });
  ```
- `packages/server/src/env.ts:98-100` — a comment warns this regex is duplicated in the config package ("If you change this, change it there too") — find that twin (`grep -rn 'KEY|PASSWORD|SECRET|TOKEN' packages/config/src/`) and change both.
- Only key-form tests are uppercase: `packages/server/__tests__/env.test.ts:234-235` (`AUTH_SECRET=`, `DB_PASSWORD:`).
- The only in-repo caller is `env.ts:179`; the export is for app authors.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/server..." run build` | exit 0 |
| Tests (server) | `pnpm --filter "@lunora/server" run test` | all pass |
| Tests (config twin) | `pnpm --filter "@lunora/config" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/server" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/server/src/env.ts`
- The duplicated regex in `packages/config/src/` (locate it; keep both byte-identical per the existing comment)
- `packages/server/__tests__/env.test.ts` (+ the config twin's test file if one covers the copy)

**Out of scope**:
- The value-shape heuristics (`looksLikeSecretValue`, entropy floor, prefixes) — unchanged.
- `@visulima/redact` usage in observability — different layer.

## Git workflow

- Branch: `improve/wave22-server`
- Commit: `fix(server): redact camelCase and lowercase secret keys`

## Steps

### Step 1: Replace the suffix regex with a boundary-aware one

Replace `SECRET_KEY` (in both copies) with a pattern matching the four suffixes at a real word boundary in any of the three conventions:

```ts
/**
 * A key is secret-named when it ends in key/password/secret/token as a real
 * word: SCREAMING_SNAKE (`API_KEY`, `TOKEN`), snake/kebab (`api_key`), or
 * camelCase (`apiKey`). A boundary is required so `MONKEY`/`monkey` (ends in
 * "key" mid-word) never matches. Duplicated in @lunora/config — keep in step.
 */
const SECRET_KEY = /(?:^|[_-])(?:key|password|secret|token)$|[a-z](?:Key|Password|Secret|Token)$|(?:^|[_-])(?:KEY|PASSWORD|SECRET|TOKEN)$|[A-Z](?:KEY|PASSWORD|SECRET|TOKEN)$/u;
```

Wait — verify each alternation against the test matrix in Step 2 before committing to this exact pattern; the required behaviour is the spec, the regex is yours to get right:

| key | redact? |
|---|---|
| `API_KEY`, `AUTH_SECRET`, `DB_PASSWORD`, `TOKEN` | yes (today's behaviour, keep) |
| `password`, `secret`, `token`, `key` (bare) | yes |
| `apiKey`, `authSecret`, `apiToken`, `clientSecret` | yes |
| `api_key`, `client-secret` (if `KEYED_VALUE` admits `-`; it does not — `\w` only — so kebab is unreachable; don't add support) | n/a |
| `MONKEY`, `monkey`, `donkey=...` | **no** |
| `sortKey`, `idempotencyKey` | yes — accepted over-redaction; camel boundary is real. Document it. |

**Verify**: `pnpm --filter "@lunora/server" run test -- env` → existing tests pass.

### Step 2: Tests

Add to `env.test.ts` (model on the existing "masks the value following a secret-named key" test at :232):
- `password: hunter2` → `password=[redacted]`
- `apiToken=abc123` → `apiToken=[redacted]`
- `authSecret: x` → redacted
- `MONKEY=banana` and `monkey: banana` → **unchanged**
- `TOKEN=abc` → still redacted (regression)

Mirror whichever of these the config twin's suite covers.

**Verify**: `pnpm --filter "@lunora/server" run test -- env` → all pass; `pnpm --filter "@lunora/config" run test` → all pass.

### Step 3: Sweep for changed diagnostics

Run the full server suite. Any unrelated test that now sees `[redacted]` in an error-message assertion (e.g. a diagnostic containing `sortKey=...`) is expected over-redaction: update the assertion and list each in the commit body.

**Verify**: `pnpm --filter "@lunora/server" run test` → all pass.

## Test plan

The Step 2 matrix in `env.test.ts`; existing uppercase tests unchanged; full server + config suites green.

## Done criteria

- [ ] Both regex copies (server + config) byte-identical (`diff <(grep -A1 "SECRET_KEY" packages/server/src/env.ts) <(grep -A1 ... packages/config/...)` or eyeball)
- [ ] `pnpm --filter "@lunora/server" run test` and `pnpm --filter "@lunora/config" run test` exit 0 with the new cases
- [ ] `MONKEY=banana` test proves no new false-positive class
- [ ] `pnpm --filter "@lunora/server" run lint:types` + `lint:eslint` exit 0

## STOP conditions

- The config twin's regex has already diverged from server's (report the divergence before unifying).
- More than ~5 existing tests change under over-redaction — the boundary is then too loose; report the list instead of updating them all.

## Maintenance notes

- The behaviour table in Step 1 is the contract; future suffixes (e.g. `credential`) get a table row + test first.
- Reviewer: check the two copies stayed identical and the `MONKEY` negative test exists.
