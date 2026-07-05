# Plan 118: Unify the jsonResponse helpers and migrate thrown-error envelopes to toErrorBody

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/do/src/session-do.ts packages/do/src/shard-registry-do.ts packages/do/src/shard-do.ts packages/do/src/admin-export-import.ts packages/d1/src/admin-export-import.ts packages/scheduler/src/scheduler-do.ts packages/payment/src/create-payment.ts packages/runtime/src/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes response construction on paths other code parses)
- **Depends on**: plans/117-errors-redaction-quick-wins.md (establishes the
  redaction pattern this plan copies; run 117 first)
- **Category**: tech-debt / security
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

After the `@lunora/errors` migration (#101), the class hierarchy and the outer
wire seams use `toErrorBody`, but ~41 hand-built `{ error: { code, message } }`
envelope literals across ~11 server files still construct error responses by
hand — bypassing the catalog (no redaction guarantee, status/shape can drift).
Separately, **five near-identical `jsonResponse` helpers exist with two
different argument orders — two of them inside the same package** —
`(status, body)` in `session-do.ts`/`shard-registry-do.ts` vs `(body, status)`
in `shard-do.ts`/`create-payment.ts`. A copied call site silently swaps status
and body (both typecheck: `body` is `unknown`). This plan unifies the helper
signature and migrates the **thrown-error** envelope sites (where a caught
`error` object's message is embedded) to `toErrorBody`; static protocol
envelopes keep their shape.

## Current state

The five helper definitions (read at `b6eb48dcd`):

- `packages/do/src/session-do.ts:106` — `const jsonResponse = (status: number, body: unknown): Response =>` (status-first)
- `packages/do/src/shard-registry-do.ts:66` — same status-first shape
- `packages/do/src/shard-do.ts:1359` — `const jsonResponse = (body: unknown, status = 200, bookmark?: string): Response =>` (body-first, plus a `x-d1-bookmark` header)
- `packages/payment/src/create-payment.ts:30` — `const jsonResponse = (body: unknown, status: number): Response =>` (body-first)
- `packages/scheduler/src/scheduler-do.ts:191-196` — `private static json(body, status = 200)` + `private static error(status, code, message)` building `{ error: { code, message } }`

Example hand-rolled envelopes:

- `packages/do/src/session-do.ts:222` —
  `return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "missing or invalid SessionDO secret" } });`
  (static message — protocol envelope, parsed by runtime callers)
- `packages/runtime/src/security-headers.ts:~430 and ~465` — two
  `Response.json({ error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin … rejected" } }, { …, status: 403 })`
  (static messages — browser-visible CSRF rejections)
- `packages/scheduler/src/scheduler-do.ts:341` —
  `Response.json({ error: { code: "NOT_FOUND" } }, { …, status: 404 })`
- Files containing envelope literals (grep `error: { code` at `b6eb48dcd`):
  `do/{shard-registry-do,admin-export-import,shard-do,relay-hub,session-do}.ts`,
  `d1/admin-export-import.ts`, `runtime/{security-headers,workflows-admin-routes,import-stream,create-worker}.ts`,
  `scheduler/scheduler-do.ts` (client-side files `client/src/{errors,types,lunora-client}.ts`
  and `db/src/internals.ts` are **decoders**, not builders — out of scope).

The redaction pattern to copy is `toErrorBody` from `@lunora/errors`
(see `packages/errors/src/to-error-body.ts`; usage exemplar after plan 117:
`packages/server/src/http.ts` `errorResponse`).

Conventions: no `.js` extensions in relative imports; named exports only;
`shared/` at the repo root is for zero-dependency helpers inlined by the
bundler (consumers import by relative path `../../../shared/<file>`; the
consumer's tsconfig must not set `outDir`/`rootDir` — see the breadcrumb
comments in e.g. `packages/client/tsconfig.json`). Enforced commit types:
`build, chore, ci, deps, docs, feat, fix, perf, refactor, revert, security,
style, test, translation`.

## Commands you will need

| Purpose      | Command                                                                                                                                                                                                       | Expected on success |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Build deps   | `pnpm --filter "@lunora/<pkg>..." run build`                                                                                                                                                                  | exit 0              |
| Tests        | `pnpm --filter "@lunora/do" run test` (~990 tests), `@lunora/runtime` (~430), `@lunora/scheduler` (~100), `@lunora/payment`, `@lunora/d1` note: d1 tests may not run in this environment — rely on lint:types | pass                |
| Types / lint | `pnpm --filter "@lunora/<pkg>" run lint:types` / `lint:eslint`                                                                                                                                                | exit 0              |

## Scope

**In scope**:

- `shared/json-response.ts` (create — zero-dep helper)
- `packages/do/src/{session-do,shard-registry-do,shard-do,admin-export-import,relay-hub}.ts`
- `packages/d1/src/admin-export-import.ts`
- `packages/scheduler/src/scheduler-do.ts`
- `packages/payment/src/create-payment.ts`
- `packages/runtime/src/{security-headers,workflows-admin-routes,import-stream,create-worker}.ts`
- tsconfig of any package newly importing from `shared/` (drop
  `outDir`/`rootDir` if set, with the breadcrumb comment — copy the wording
  from `packages/client/tsconfig.json`)
- Tests asserting the touched responses (expectation updates only)

**Out of scope**:

- Changing any **response JSON shape** (`{ error: { code, message } }` stays).
- Changing any **status code**.
- Client-side decoder files (`packages/client/*`, `packages/db/*`).
- `packages/server/src/http.ts` (plan 117 owns it).
- `packages/errors/src/guards.ts` (plan 119).
- Adding new codes to `ERROR_CATALOG` (e.g. `FORBIDDEN_ORIGIN` stays a local
  literal — cataloging it is a follow-up, noted in Maintenance).

## Git workflow

- Branch: `advisor/118-error-envelope-consolidation`
- Suggested commits: `refactor(do): unify jsonResponse signature via shared helper`,
  `refactor: route caught-error envelopes through toErrorBody`.

## Steps

### Step 1: Create the shared helper and unify the five definitions

Create `shared/json-response.ts` — **zero-dependency** (no imports at all):

```ts
/**
 * The one JSON-response helper (body-first, mirroring `Response.json`).
 * Replaces the per-file copies that had drifted into two argument orders —
 * `(status, body)` vs `(body, status)` — a silent-swap foot-gun.
 */
export const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
    Response.json(body, { headers: { "content-type": "application/json", ...headers }, status });
```

Then, per file:

- `session-do.ts` + `shard-registry-do.ts`: delete the local helper, import
  the shared one, and flip every call site from `jsonResponse(status, body)`
  to `jsonResponse(body, status)`. Find call sites with
  `grep -n 'jsonResponse(' packages/do/src/session-do.ts packages/do/src/shard-registry-do.ts`.
- `shard-do.ts`: delete the local helper; its bookmark variant becomes
  `jsonResponse(body, status, bookmark ? { "x-d1-bookmark": bookmark } : undefined)` —
  or keep a 3-line local wrapper that delegates to the shared helper if call
  sites are numerous. Do NOT change any call-site semantics.
- `create-payment.ts`: replace local helper with the shared import (signature
  already matches).
- `scheduler-do.ts`: replace the `SchedulerDO.json` static's body with a
  delegation to the shared helper (keep the static so call sites don't churn).

**Verify** after each file:
`pnpm --filter "@lunora/do..." run build && pnpm --filter "@lunora/do" run test` (and the
scheduler/payment equivalents) → all pass;
`grep -rn 'const jsonResponse = (status' packages/` → no matches.

### Step 2: Triage the envelope sites

For each file in the grep list, classify every `error: { code` literal:

| Class                           | Definition                                                                        | Action                            |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| **A: caught-error embed**       | a caught `error`'s `.message` (or `String(error)`) is embedded in the envelope    | migrate to `toErrorBody` (Step 3) |
| **B: static protocol envelope** | fixed literal code+message (e.g. `UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `NOT_FOUND`) | leave as-is                       |

Record the classification table in your final report. Expect most sites to be
class B — the audit found class-A candidates primarily in
`admin-export-import.ts` (do + d1), `workflows-admin-routes.ts`,
`import-stream.ts`, and `scheduler-do.ts` catch blocks; verify by reading each.

### Step 3: Migrate class-A sites to `toErrorBody`

For each class-A site, replace the hand-built message with:

```ts
const { body, redacted, status } = toErrorBody(error, { fallbackCode: "<the code the site used before>", redactedMessage: "Internal error" });
// log `error` server-side when `redacted` (console.error, matching the
// pattern in packages/server/src/http.ts errorResponse after plan 117)
return jsonResponse({ error: { code: body.code, message: body.message } }, status);
```

Preserve the site's **outer shape and status semantics**: if the old code
returned 500 with a specific code on any failure, `fallbackCode` is that code.
`@lunora/errors` is already a dependency of do/runtime/scheduler (verify in
each `package.json`; payment/d1 — add it with the exact current version if
missing, mirroring sibling entries).

**Verify**: full test suites for do, runtime, scheduler, payment →
all pass. `pnpm --filter "@lunora/d1" run lint:types` → exit 0.

## Test plan

- Add one regression test per migrated class-A file asserting: a handler-path
  error whose message contains a marker string (e.g. `"SECRET_MARKER"`) with
  an internal code produces a response body that does NOT contain the marker.
  Model after the existing redaction test in
  `packages/do/__tests__/` (search `grep -rln "internal error" packages/do/__tests__` for the shard-do RPC redaction test added in plan 064).
- The signature unification needs no new tests (existing suites cover the
  endpoints), but MUST NOT reduce assertion counts.

## Done criteria

- [ ] `grep -rn 'const jsonResponse' packages/*/src` → at most thin local
      wrappers delegating to `shared/json-response.ts`; zero `(status, body)`
      signatures remain
- [ ] Classification table for all `error: { code` sites reported
- [ ] Every class-A site routes through `toErrorBody`
- [ ] Test suites pass: do, runtime, scheduler, payment; `lint:types` +
      `lint:eslint` exit 0 for every touched package (incl. d1)
- [ ] No response shape or status changed (assert via the untouched existing
      endpoint tests)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any call-site flip in Step 1 is ambiguous (you cannot tell which argument is
  the status) — report the site instead of guessing.
- A class-B envelope's message/code turns out to be parsed by other Lunora
  code expecting the _exact string_ (grep the literal before changing
  anything near it) and your change would alter it.
- A package importing `shared/json-response.ts` fails `lint:types` with
  TS6059 (rootDir) even after removing `outDir`/`rootDir` from its tsconfig.
- Migrating a site would change its HTTP status (that means the old code and
  the catalog disagree — report the discrepancy, don't pick a side).
- `packages/do` tests fail in a suite unrelated to your touched endpoints
  (possible cross-contamination — report).

## Maintenance notes

- Follow-up (deferred): promote `FORBIDDEN_ORIGIN` and the other class-B
  protocol codes into `ERROR_CATALOG` so even static envelopes resolve
  status/title centrally. Deferred because it changes nothing observable today
  and touches the catalog's public type.
- Reviewers: diff-check that every flipped `jsonResponse` call really swapped
  its arguments (the type system can't catch a missed one — `body` is
  `unknown`, so `jsonResponse(401, {...})` still compiles as body=401).
- Plan 119 (guard hardening) touches `toErrorBody`'s inputs; land this first
  so 119's behavior change is observable at these sites too.
