# Plan 486: Decide how raw data-read and observability MCP tools are gated

> **Executor instructions**: Step 0 is decided (option A). Steps 1-3 may run.
> Follow the steps in order. Run every verification command and confirm the
> expected result before moving on. If anything in "STOP conditions" occurs,
> stop and report.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/mcp/src packages/auth/src/mcp-auth.ts packages/auth/src/plugins.ts`
> If any in-scope file changed, re-check the "Current state" excerpts against
> the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (S if option C is chosen)
- **Risk**: MED
- **Depends on**: none (decision recorded: option A, default-deny scopes, 2026-10-11)
- **Category**: security
- **Planned at**: commit `dcffa4d73`, 2026-10-11

## Why this matters

`@lunora/mcp` exposes tools that return production user data to the model's
context, and therefore to the model provider: log lines, request metadata,
grouped error messages, and raw table rows read through the admin writer (which
bypasses RLS and column masks). Today these are guarded by **process-level
environment or constructor opt-ins** (`LUNORA_MCP_ALLOW_DATA_READS`,
`LUNORA_MCP_ALLOW_OBSERVABILITY`, `allowDataReads`, `allowObservability`). They
are not guarded by a **per-principal scope**. On the OAuth-protected remote
path, an authenticated client has no scope it can be granted or denied for these
tools, and nothing in the auth layer defines one. The gap is therefore not an
open default. It is that the decision cannot be made per caller, and it has
not been recorded which of the three policies is wanted.

## Current state

**Tools that return raw rows or observability data**

- `lunora_find_related` — raw table rows through the admin writer, RLS and column
  masks not applied. Definition at `packages/mcp/src/row-read-tools.ts:60`;
  dispatch at `:169`. Its description says so: "RLS policies and column masks do
  not apply to what it returns."
- `lunora_get_logs`, `lunora_get_issues`, `lunora_get_advisories`,
  `lunora_get_query_insights`, `lunora_get_migration_status` — log lines, request
  metadata, grouped error messages. Definitions at
  `packages/mcp/src/observability-tools.ts:194, 202, 209, 216, 223`.
- `lunora_run_query` — **not** gated. It runs a declared query and returns its
  result (`packages/mcp/src/tools.ts:75` definition, `:305-310` dispatch). Its
  output is whatever the app's query returns, so it is user data by construction.
  It is listed here so the decision covers it explicitly; the finding does not
  say it is a bug, since the app author controls what the query exposes.

**Existing gates (none is a scope)**

- Gate type and families: `packages/mcp/src/tools.ts:350` (`ToolGate` union of
  `allowDataReads | allowObservability | allowWrites`); `:404-421` declares the
  `allowDataReads` and `allowObservability` families with refusal messages naming
  the env var; `:438-450` `closedGate` / `toolDefinitions` omit a closed family;
  `:455-482` `callTool` re-checks the same gate at dispatch.

    ```ts
    flag: "allowObservability",
    refuse: (name) => `tool "${name}" is disabled: it reads the deployment's logs, request metadata and grouped errors ...`,
    ```

- Constructor opt-ins with the policy text: `packages/mcp/src/server.ts:83-92`
  (`allowDataReads`, `allowObservability`). Effective only with an admin token:
  `server.ts:187` and `:190` (`&& hasAdminToken`). The comment at `server.ts:184-186`
  states that holding the bearer is deliberately not consent.
- Env wiring: `packages/mcp/src/run-bin.ts:12-13` (docs), `:99-100` (reads the env).
- Local dev server: `packages/mcp/src/local.ts:157-170` treats a resolved dev
  token as the observability opt-in. This is a different trust decision and is
  out of scope for the gate change.

**Authed (OAuth) path**

- `packages/mcp/src/authed-http.ts:120`: `server` is either a fixed options object
  or `(claims) => LunoraMcpServerOptions`. A per-claims function can therefore set
  `allowDataReads` / `allowObservability` today, but the library does nothing with
  the claims for these families.
- `packages/mcp/src/authed-http.ts:146-151` and `:240-241`: the only scope check.
  It guards the write and agent tools only, via a caller-supplied `stepUp.scope`.
  No scope is checked for the data-read or observability families.
- `packages/mcp/src/authed-http.ts:176-181` `mcpTokenScopes`: parses the `scope`
  claim. It is a helper, not a gate.

**Scope names the auth layer issues**

- `packages/auth/src/mcp-auth.ts:71` `requireMcpAuth` and `:99` export: wrap
  better-auth. No `lunora:*` scope literal is defined or defaulted anywhere in
  `packages/auth/src`.
- `packages/auth/src/plugins.ts:128` re-exports `createInsufficientScopeError`
  from better-auth. It defines no scope names.
- The only `lunora:read` / `lunora:write` strings are in doc comments and docs
  examples: `packages/mcp/src/authed-http.ts:27, 32, 35, 163`,
  `packages/mcp/docs/index.mdx:364, 384, 478`. They are **caller-chosen** values
  passed to better-auth's `mcp({ scopes })`. Lunora issues no scope. No
  `lunora:data` or `lunora:observability` scope exists.

**Title drift**

The index row reads "Gate raw data-read and observability MCP tools behind a
scope." Those tools are already gated, by env and constructor opt-ins, which are
default-off. What is missing is a scope-based gate on the authed path. The plan
is scoped to that. The plan's row is in `plans/README.md`.

## Step 0: Maintainer decision (REQUIRED before any step below)

The maintainer chose option A on 2026-10-11. The options are kept below as the
record of what was weighed.

**Decision**: A, recorded 2026-10-11.

- **(A) Add a new scope for raw data and observability tools, default-deny.**
  Define `lunora:data-read` (for `lunora_find_related`, and `lunora_run_query` if
  the maintainer includes it) and `lunora:observability` (for the five
  `lunora_get_*`). Extend the authed `stepUp` path so these families are omitted
  and refused unless the token carries the scope. The env and constructor opt-ins
  stay as the operator's process-level switch.
    - Pro: the only option that makes the decision per principal. An OAuth client
      can be granted or denied the data, and the consent screen can say so.
    - Pro: matches the existing `stepUp` pattern used for writes.
    - Con: new public names, so a snapshot and docs change. Lunora then has to
      define scopes it does not issue today, which is a new contract.

- **(B) Reuse an existing scope.**
  Map both families onto `lunora:read`, or onto `lunora:write` as a reuse of the
  step-up scope.
    - Pro: no new name, no new contract.
    - Con: `lunora:read` is not defined by Lunora either, and `lunora:write` is the
      wrong class. A write-capable token would then also read production logs and
      raw rows, which is the coupling the existing code deliberately avoids
      (`server.ts:86-89` separates the two classes).

- **(C) Leave ungated and document it.**
  Keep the current env and constructor opt-ins, which are default-off. Document
  that the authed path has no per-principal control over these families, and
  leave the operator to decide by setting the options from claims.
    - Pro: no code change, and the default-off behaviour is already tested.
    - Con: the authed path has no way to grant the data to one client and not
      another, without operator code.

**Recommendation: (A).** The current gates are sound as process switches but
cannot express "this OAuth client may read logs and that one may not", which is
the question a remote MCP server gets asked. The existing `stepUp` pattern
already gives writes that per-principal check, so extending it is the smallest
consistent change. Reconsider (C) if the maintainer does not want Lunora to
define scope names. Do not choose (B): it reuses the write scope for read data,
which is the coupling this code avoids.

Once a decision is recorded, change the Status block's **Depends on** line to
`none (decision recorded: <option>)` and continue. Until then, do not dispatch.

## Commands

| Purpose       | Command                                       | Expected on success |
| ------------- | --------------------------------------------- | ------------------- |
| Build deps    | `pnpm --filter "@lunora/mcp..." run build`    | exit 0              |
| Package tests | `pnpm --filter "@lunora/mcp" run test`        | all pass            |
| Typecheck     | `pnpm --filter "@lunora/mcp" run lint:types`  | exit 0              |
| Lint          | `pnpm --filter "@lunora/mcp" run lint:eslint` | exit 0              |
| API snapshot  | `pnpm run api:check`                          | exit 0              |
| Package.json  | `pnpm run lint:package-json`                  | exit 0              |

If a script name differs, run `pnpm --filter "@lunora/mcp" run` and use what it
lists. Do not guess.

## Scope

**In scope** (only if the decision is A; for C, only the docs listed):

- `packages/mcp/src/tools.ts` (gate families, `ToolGate`)
- `packages/mcp/src/server.ts` (option docs, scope-derived flags)
- `packages/mcp/src/authed-http.ts` (step-up for data and observability families)
- `packages/mcp/src/run-bin.ts` and `packages/mcp/src/index.ts` (docs only)
- `packages/mcp/docs/index.mdx`
- `packages/mcp/__tests__/authed-http.test.ts`, `authed-http.e2e.test.ts`
- `api-snapshots/` entries for `@lunora/mcp`, after a fresh build

**Out of scope** (do not touch):

- `packages/auth/src/*`. Lunora does not issue scopes, and the names belong to
  the caller. Do not add a default scope list there without a separate decision.
- `packages/mcp/src/local.ts`. Its dev-token opt-in is a different trust
  decision.
- `lunora_run_query` gating, unless the maintainer names it in Step 0.
- `lunora_run_mutation`, `lunora_run_action`, and the agent tools. They already
  have a scope step-up.

## Git workflow

- Branch: `advisor/486-mcp-data-scope`, from `alpha`.
- One commit. Subject example: `feat(mcp): gate raw-row and observability tools behind scopes`.
- The body must not name any external product or project that the idea came from.
- Do NOT push, and do NOT open a PR unless the operator says so.

## Steps after the decision

These apply to option A. For option C, Steps 1-2 only: record the decision in
the docs, and state that no code changes.

### Step 1: Record the scope contract

Name the scopes in one place (for example a const in `tools.ts`) and derive the
families' gates from it. Do not repeat the literal strings across files.

**Verify**: `grep -rn "lunora:data-read\|lunora:observability" packages/mcp/src`
shows the literals in the one place only.

### Step 2: Gate the families on the scope on the authed path

In `authed-http.ts`, extend the step-up check (`:240`) so a call to a data-read
or observability tool is challenged unless `mcpTokenScopes(claims)` has the
matching scope. Keep the env and constructor flags as the outer gate. A tool
opens only when both allow it.

**Verify**: a new test in `authed-http.test.ts` shows that a token without the
scope gets `insufficient_scope` for `lunora_get_logs`, and that a token with it
gets past the challenge.

### Step 3: Update docs and the API snapshot

Add the scopes to `packages/mcp/docs/index.mdx` next to the `lunora:write` example
at `:364`. Build, then run `pnpm run api:update` only if `api:check` reports drift
in `@lunora/mcp`. Drift in any other package is a STOP.

**Verify**: `pnpm run api:check` exits 0.

## Test plan

- Authed path: a token with no data scope cannot reach `lunora_find_related` or
  any `lunora_get_*` tool, and gets the challenge naming the scope.
- Authed path: a token with the scope reaches them, but only when the constructor
  flag is also set (the outer gate still holds).
- Unauthed path: unchanged. The existing `tools.ts` refusal tests still pass.
- Workerd: `packages/mcp` does not touch SQL or a Durable Object. Check with
  `grep -n workerd packages/mcp/vitest.config.ts`. If the project exists, run
  `pnpm --filter "@lunora/mcp" run test:workerd`.

## Platform parity

Not applicable to the matrix. This plan changes MCP tool exposure, not a
`ctx.*` surface or a provider binding. No `PlatformCapabilities` row changes.
Under option C, nothing changes at all.

## Done criteria

- [ ] Step 0 decision is recorded in this file, with the option name
- [ ] Under A: the scope literals are defined in one place only
- [ ] Under A: the authed-path tests above exist and pass
- [ ] `pnpm --filter "@lunora/mcp" run test` exits 0
- [ ] `pnpm --filter "@lunora/mcp" run lint:types` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `git status` shows changes only inside the in-scope list
- [ ] The `plans/README.md` row for 486 is updated

## STOP conditions

- The Step 0 decision is not recorded. Do not dispatch.
- The code at `tools.ts:404-421`, `server.ts:187-190`, or `authed-http.ts:240`
  does not match the excerpts above (drift).
- Under A, the work needs a scope that a caller can define differently than the
  library does. Report instead of inventing a default.
- A `lunora_*` tool outside this list turns out to return raw rows or logs. Report
  it; do not widen the gate silently.
- The same verification fails twice after a reasonable fix attempt.

## Open questions (answer during execution)

1. Should `lunora_run_query` be in the new data-read family? It returns whatever
   the app's query exposes, so the answer changes the scope's meaning.
2. Does the maintainer want Lunora to define scope names, or to leave them to
   the caller (option C)?
3. Is the `plans/README.md` row for 486 meant to exist on `alpha`, or only in the
   working-tree index?
