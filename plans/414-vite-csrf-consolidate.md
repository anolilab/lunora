# Plan 414: Collapse the Vite host's hand-copied CSRF gate onto the shared studio-host implementation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/vite/src/studio-plugin.ts packages/config/src/studio-host/serve-json-handler.ts packages/config/src/studio-host/index.ts`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt | security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/vite/src/studio-plugin.ts:55-116` re-implements `originRejectionReason` + `csrfRejectionReason` line-for-line from `packages/config/src/studio-host/serve-json-handler.ts:73-145` — same `Sec-Fetch-Site` allowlist (spelled inline in one, as `SAME_SITE_FETCH_VALUES` in the other), same Origin-vs-Host fallback, same content-type layer — and then hands the request to the config copy anyway (`studio-plugin.ts:280-303`), so the Vite copy is a redundant pre-check. Two copies of a security gate that must stay identical, with a written precedent in the same directory of exactly this drift causing a token disclosure: `transport-guard.ts:9-16` documents that the two hosts "previously diverged on exactly this guard… a relay reaching the CLI host's loopback socket with `Host: localhost` was served the token-bearing document." Only the config copy is exercised by the config package's tests.

## Current state

- `packages/vite/src/studio-plugin.ts:55-88` — local `originRejectionReason(headers)` (inline `"same-origin" || "same-site" || "none"` check, Origin URL parse, Host comparison); `:96-116` — local `csrfRejectionReason(request)` layering origin + content-type.
- `packages/config/src/studio-host/serve-json-handler.ts:73` — `SAME_SITE_FETCH_VALUES`; `:81` — `originRejectionReason(request)`; `:128` — `csrfRejectionReason(request)`; consumed at `:173`. **Not exported**: `packages/config/src/studio-host/index.ts` exports handlers and `transportRejectionReason` etc., but `grep -n "csrfRejectionReason" packages/config/src/studio-host/index.ts` → no match.
- The Vite plugin already imports from the subpath: `packages/vite/src/studio-plugin.ts:10,28` — `from "@lunora/config/studio-host"`.
- Signature note: the Vite copy takes `headers`, the config copy takes `request` — the consolidation uses the config copy's `request` signature (the Vite middleware has the `IncomingMessage`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/vite..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/config" run test && pnpm --filter "@lunora/vite" run test` | all pass |
| Typecheck | both packages `run lint:types` | exit 0 |
| API snapshot | `pnpm run build:packages && pnpm run api:check` | exit 0 (`api:update` after fresh build for the new export) |

## Scope

**In scope**:
- `packages/config/src/studio-host/serve-json-handler.ts` (export `csrfRejectionReason`; keep `originRejectionReason` private unless the Vite call sites genuinely need it separately — read them; the goal is ONE exported gate)
- `packages/config/src/studio-host/index.ts` (re-export)
- `packages/vite/src/studio-plugin.ts` (delete the two local copies, import the shared one; keep the belt-and-braces double invocation — middleware calls it before `serveJsonHandler` deliberately, note that in a comment)
- `packages/config/__tests__/` (if `csrfRejectionReason` has no direct unit tests, add the export-level ones; the behaviour tests may already exist via the handler — check)
- `api-snapshots/config.api.md` via `pnpm run api:update`

**Out of scope**:
- Any behaviour change to the gate itself. This is a pure consolidation; both hosts must answer identically before and after.
- `transport-guard.ts`, the WS upgrade path.

## Git workflow

- Branch: `improve/wave22-config`
- Commit: `refactor(config): share the studio csrf gate with the vite host`
- Body: note the drift-precedent rationale (transport-guard incident).

## Steps

### Step 1: Export the gate

Export `csrfRejectionReason` from `serve-json-handler.ts` and re-export through `studio-host/index.ts` with a doc comment naming the consolidation rationale (cite `transport-guard.ts`'s precedent).

**Verify**: `pnpm --filter "@lunora/config" run lint:types` → exit 0.

### Step 2: Delete the Vite copies

Remove `originRejectionReason` and `csrfRejectionReason` from `studio-plugin.ts` (and any now-unused helpers only they used — e.g. a local `headerValue` if nothing else calls it; grep before deleting). Import the shared one; add the "deliberately invoked before serveJsonHandler" comment at the call site.

**Verify**: `pnpm --filter "@lunora/vite" run test` → all pass unmodified (identical behaviour). `grep -c "csrfRejectionReason" packages/vite/src/studio-plugin.ts` → matches are import + call sites only, no local definition.

### Step 3: API snapshot

`pnpm run build:packages && pnpm run api:update`; commit the `config.api.md` delta (one added export).

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

- Existing config handler tests already cover the gate's behaviour; add direct unit tests for the newly exported function only if none exist at export level (cross-origin rejected, same-origin allowed, sec-fetch-site absent → Origin fallback, content-type layer) — 4 cases, model on the existing serve-json-handler tests.
- Vite tests must pass **without modification** — that is the no-behaviour-change proof.

## Done criteria

- [ ] No local `originRejectionReason`/`csrfRejectionReason` definitions remain in `packages/vite/src`
- [ ] Both packages' tests + lint:types exit 0; Vite tests unmodified
- [ ] `pnpm run api:check` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The two copies turn out NOT to be behaviourally identical (any divergence found while diffing them) — that divergence is itself a security finding; STOP and report it rather than silently picking one behaviour.
- The Vite copy is exercised by a test that asserts host-specific behaviour the shared gate doesn't have.

## Maintenance notes

- Future gate changes happen in one file and both hosts pick them up — a third host must import it too.
- Reviewer: diff the deleted Vite code against the shared implementation one last time; a hidden delta is the whole risk here.
