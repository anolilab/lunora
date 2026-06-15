# Plan 025: Access-rule editor + permissions playground

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This is a multi-item feature plan (like plans 022,
> 023, 024): each numbered item under "Item breakdown" is its own PR. Execute
> them in order. When an item is done, update its checkbox and the status row for
> this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 05a1e9fc..HEAD -- packages/server/src/rls packages/studio/src/features/functions/function-runner.tsx packages/studio/src/lib/admin.ts packages/do/src/introspect.ts packages/advisor/src/lints/static/rls-uncovered-table.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 (closes the biggest perceived gap vs Supabase/PocketBase —
  Cirrus has the authorization _engine_ but no authoring/testing UI)
- **Effort**: L (a read-only permissions matrix + a live "run-as" probe playground
    - a local-dev policy/role scaffolder)
- **Risk**: MEDIUM-LOW. The playground is read + `runAs` only (no source writes,
  no data mutation beyond what the probed function does). The scaffolder writes
  _stub_ policy/role source under `cirrus/` (local-dev, capability-gated, additive
  only) — it never authors the actual predicate logic and never auto-applies a
  policy to a procedure destructively.
- **Depends on**: soft-depends on **plan 024** (reuses 024's local-dev write-back
  endpoint + capability-flag pattern for the scaffolder half — Item 3). The
  playground halves (Items 1–2) have no dependency.
- **Category**: feature / borrow (PocketBase + InstantDB)
- **Planned at**: commit `05a1e9fc`, 2026-06-15

## Verdict on the borrow

**Sources**: PocketBase (MIT — per-collection visual filter-rule editor + a rule
tester) and InstantDB (permissions UI + "check permissions" sandbox). Both let a
developer _author_ and _test_ access rules from a UI; that authoring/testing UX is
where Supabase/PocketBase feel ahead of Cirrus.

**What we borrow**: the _interaction model_ — (a) a **permissions matrix** that
shows, per table × operation × role, which policy covers it, and (b) a
**permissions playground** that runs a function as a chosen identity and shows the
allow/deny outcome. **What we do NOT borrow**: visual authoring of arbitrary rule
_logic_. Cirrus access rules are TypeScript — `definePolicy({ table, on, when })`
where `when` is an arbitrary `(ctx) => PolicyDecision` function
(`packages/server/src/rls/define.ts:10`). A UI cannot fully author arbitrary code
(PocketBase's rules are a constrained filter DSL; Cirrus's are full TS). So the
"editor" half is a **scaffolder** (generate a `definePolicy`/`defineRole` stub and
wire `.use(rls(...))`), not a predicate authoring tool — the developer fills in the
`when` body. This mirrors plan 024's "additive scaffolding, no destructive
auto-apply" boundary and is local-dev-only and capability-gated for the same
reasons.

The headline deliverable is the **playground** (Items 1–2): it is pure
read + `runAs`, ships without touching source or the worker's write path, and is
the single highest-leverage thing — Cirrus already exposes everything it needs.

## Why this matters

Cirrus already has: the RLS middleware (`packages/server/src/rls/middleware.ts`),
roles/permissions (`defineRole`/`definePermission`), data masking (plan 023,
`packages/server/src/mask/`), two security advisor lints (`rls_uncovered_table`,
`mask_uncovered_pii_column`), an admin RPC that returns policy + role metadata
(`__cirrus_admin__:rlsPolicies` → `{ policies, roles }`), and a "Run as identity"
control in the function runner that forges a user and dispatches through `runAs`
so RLS evaluates under that identity. **Every piece of a permissions playground
already exists — it is just not assembled into a permissions view.** A developer
today has no single place to answer "who can read `invoices`?" or "does this
function deny an anonymous user?" without reading code and hand-running the
function runner. This plan assembles those pieces.

## Design decisions (already scoped)

- **Playground = read + `runAs` only.** The matrix reads
  `__cirrus_admin__:rlsPolicies` (+ `maskPolicies`) — already present. The probe
  reuses the existing `runAs` admin RPC (forge identity → dispatch a chosen
  function → show allow/deny/result). No new worker op for Items 1–2.
- **Live-probe gated on `runAsIdentity`.** Forging an identity is already a
  loopback-only affordance (`window.__CIRRUS_RUN_AS_IDENTITY__`,
  `function-runner.tsx`). The read-only matrix shows everywhere; the probe button
  only renders when `runAsIdentity` is set, matching the function runner.
- **Editor = local-dev scaffolder, additive only.** Generating a policy/role stub
  edits `cirrus/` source via ts-morph + codegen — same constraints as plan 024.
  Reuse 024's local schema-edit endpoint + capability flag (or a sibling
  `policiesEditable` flag) rather than building a second endpoint. It scaffolds:
  a `definePolicy`/`defineRole` skeleton file and (optionally) wires
  `.use(rls(policies))` into a chosen procedure. It does **not** author the `when`
  body and does **not** rewrite an existing procedure's logic destructively.
- **No new authorization semantics.** This plan surfaces and tests the existing
  engine; it changes no policy evaluation behaviour in `@cirrus/server`.

## Current state

### RLS engine (read-only facts the UI surfaces)

`packages/server/src/rls/define.ts` — `definePolicy` (line 10), `definePermission`
(line 21), `definePolicies` (line 40, validates duplicate `(table, on)` and
identical `when` refs), `defineRole` (line 64).

`packages/server/src/rls/types.ts` — `PolicyOperation = "delete" | "insert" |
"read" | "update"` (line 27); `PolicyDecision = WhereInput | boolean | undefined`
(line 47); `PolicyContext.auth = { can, identity?, roles, userId }` (lines 58–73).

`packages/server/src/rls/middleware.ts` — `rls(policies, options)` (line ~987);
reads OR-ed, writes AND-ed default-deny; `count`/`rank` fail closed under an
active read policy.

### Admin metadata RPCs (already wired)

`packages/studio/src/lib/admin.ts` — `ADMIN_FUNCTIONS.rlsPolicies =
"__cirrus_admin__:rlsPolicies"` (line ~59), `maskPolicies` (line ~55), `runAs`
(line ~60). Result types: `RlsPoliciesResult = { policies: RlsPolicyMetadata[];
roles: RlsRoleMetadata[] }` (lines ~408–411); `RlsPolicyMetadata = { file, on,
procedure, table }` (lines ~386–395); `RlsRoleMetadata = { name, permissions,
description? }` (lines ~398–405); `MaskColumnMetadata = { column, strategy, table }`
(lines ~422–429).

`packages/do/src/introspect.ts` — admin function constants incl. `rlsPolicies`
(line ~68), `maskPolicies` (line ~59), `runAs` (line ~69), `studioFeatures`
(line ~76). `packages/do/src/shard-do.ts` — `handleAdminRpc` (line ~3177,
bearer-gated); `rlsMetadata()`/`maskMetadata()` dispatched at lines ~3984–4010
(codegen-supplied); `handleRunAs` (line ~3414) validates `parseRunAsArgs` and runs
`withRequestIdentity(userId, identity, () => handleRpc(...))`.

### "Run as identity" (the probe seed)

`packages/studio/src/features/functions/function-runner.tsx` — `runAsIdentity?:
boolean` prop (line 64); `run()` (lines 144–231): when `runAsIdentity` and
`runAsUserId.trim() !== ""`, dispatches via `RUN_AS = adminRef(ADMIN_FUNCTIONS.runAs)`
(line 26) with `{ args, functionPath, userId: forgedUserId }` (line ~218). This is
exactly the probe primitive — extract/reuse, do not duplicate the dispatch logic.

### Advisor lints (the matrix's "uncovered" signal)

`packages/advisor/src/lints/static/rls-uncovered-table.ts` — `rls_uncovered_table`
(WARN/EXTERNAL/SECURITY): a public procedure reads/writes a table covered by RLS
elsewhere but lacks `.use(rls(...))`. `mask-uncovered-pii-column.ts` — analogous
for masked columns. These already surface in the Advisors table /
`security-advisor-panel`; the matrix can cross-reference them ("this cell is
flagged uncovered").

### Capability flags + feature gating

`packages/config/src/studio-host/{types,render-html}.ts` — the
`window.__CIRRUS_RUN_AS_IDENTITY__` pattern (and plan-024's
`__CIRRUS_SCHEMA_EDITABLE__`). `packages/studio/src/hooks/use-studio-features.ts`
— fetches `__cirrus_admin__:studioFeatures` (mail/payments/scheduler/storage/
vectors/workflows). `use-auth-capabilities.ts` — `getAuthCapabilities()` →
`{ accounts, admin, organization, passkey, twoFactor }`.

## Commands you will need

| Purpose      | Command                                                  | Expected |
| ------------ | -------------------------------------------------------- | -------- |
| Build deps   | `pnpm run build:packages`                                | exit 0   |
| studio build | `pnpm --filter "@cirrus/studio..." run build`            | exit 0   |
| studio tests | `pnpm --filter "@cirrus/studio" run test -- permissions` | all pass |
| studio types | `pnpm --filter "@cirrus/studio" run lint:types`          | exit 0   |
| advisor test | `pnpm --filter "@cirrus/advisor" run test`               | all pass |
| eslint       | `pnpm --filter "@cirrus/studio" run lint:eslint`         | exit 0   |

Build deps once before filtered test/types (plan 016). The DO `runAs` /
`rlsMetadata` paths are workerd-bound and cannot be exercised in the sandbox —
this plan adds no worker code (Items 1–2 reuse existing RPCs), so all new tests are
plain-Node studio React + advisor tests.

## Scope

**In scope**:

- A new studio feature folder `packages/studio/src/features/permissions/` — the
  matrix, the playground, and a small client that calls the existing
  `rlsPolicies` / `maskPolicies` / `runAs` admin RPCs.
- `packages/studio/src/app/{app,studio}.tsx` — register the Permissions
  tab/panel and gate the probe on `runAsIdentity` (and the scaffolder on the
  local-edit flag).
- `packages/studio/src/locales/en.ts` — new strings.
- **Item 3 only**: extend plan-024's local schema-edit endpoint / shared
  mutation core (`@cirrus/config`) with policy/role _stub_ scaffolding, and a
  studio "scaffold policy/role" control.
- Tests alongside each.

**Out of scope** (do NOT touch):

- The RLS/mask evaluation logic in `@cirrus/server` — no semantic change.
- Any new worker/DO admin op for Items 1–2 (reuse `rlsPolicies`/`maskPolicies`/
  `runAs`). A new op is only permissible if metadata is genuinely missing — STOP
  and report first.
- Authoring the `when` predicate body from the UI (impossible for arbitrary TS —
  the editor scaffolds stubs only).
- Live data mutation beyond what a probed function legitimately does via `runAs`.

## Git workflow

- One branch per item, e.g. `feat/permissions-matrix`,
  `feat/permissions-playground`, `feat/policy-scaffolder`.
- Conventional commits, e.g. `feat(studio): add permissions matrix panel`.
- Do NOT push or open a PR unless the operator instructed it.

## Item breakdown

- [x] **Item 1 — Permissions matrix (read-only).** New
      `features/permissions/permissions-matrix.tsx`. Fetch `rlsPolicies` (+ optionally
      `maskPolicies`) via a live admin hook (mirror `migrations.tsx`'s
      `useLiveAdmin`). Render a table × operation grid: rows = tables, columns =
      `read | insert | update | delete`, each cell shows the covering policy
      (`procedure` + `file`) or "no policy" — plus the roles list and any masked
      columns. Cross-reference advisor findings to flag "uncovered" cells. Register
      as a Permissions tab in `studio.tsx` (visible whenever the studio loads; no
      capability needed — it's read-only metadata). **Tests**: renders policies into
      the grid from a mocked `rlsPolicies` result; an uncovered table shows the
      warning marker.
- [x] **Item 2 — Permissions playground (live probe).** A panel that lets the
      developer pick a function + an identity (userId / roles / claims) and run it via
      the existing `runAs` RPC, showing allow/deny + the returned/denied result. Reuse
      the function-runner's `runAs` dispatch (extract the shared call into
      `lib/internal` or a small hook rather than duplicating). Gate the run control on
      `runAsIdentity` (the read-only matrix from Item 1 stays visible without it). Link
      matrix cells → "probe this" prefilled with the cell's table/operation. **Tests**:
      probe disabled when `runAsIdentity` is false; a mocked `runAs` allow and deny
      path each render the right outcome.
- [ ] **Item 3 — Policy/role scaffolder (local-dev, additive).** Soft-depends on
      plan 024. Extend 024's shared ts-morph mutation core + local endpoint with:
      scaffold a new `definePolicy`/`defineRole`/`definePermission` stub file under
      `cirrus/` (skeleton `when` returning `false` with a TODO), and optionally wire
      `.use(rls(policies))` into a named procedure's builder chain (additive — append
      to an existing chain; never rewrite logic). Gate on the local-edit capability
      flag (reuse 024's `schemaEditable` or add a sibling `policiesEditable`). On
      success, re-run codegen and refresh the matrix. **Tests**: ts-morph fixtures for
      the stub + chain-append; the scaffold control renders only when the flag is set;
      a destructive request (rewrite an existing `when`) is refused.

## Steps (Item 1 — do this first, in full)

> Items 2–3 are scoped above; expand each into steps when you start it. Item 1 is
> the smallest safe first PR and ships standalone value.

### Step 1.1: Locale strings

In `packages/studio/src/locales/en.ts`, add (match the key-as-English-string
convention; template params in `{braces}`):

```ts
"Permissions",
"No policy",
"Covered by {procedure}",
"Uncovered — reachable without a policy",
"Read", "Insert", "Update", "Delete",
```

(Reuse existing operation strings if already present — grep first.)

### Step 1.2: Matrix component + admin client

Create `packages/studio/src/features/permissions/permissions-matrix.tsx`. Use
`useLiveAdmin` (see `features/database/migrations.tsx` for the exact pattern:
`adminRef(ADMIN_FUNCTIONS.rlsPolicies)`, `LiveError`, `errorMessage`,
`fireAndForget`). Reduce `RlsPoliciesResult` into a `table → { [op]: policy }` map.
Render a `Table` (reuse `components/ui/table`). Show roles in a header strip. If a
`maskPolicies` fetch is cheap, overlay masked-column badges per table.

### Step 1.3: Register the tab

In `packages/studio/src/app/studio.tsx`, add a `permissions` tab to the
appropriate domain group (near schema/advisors). It needs no capability flag
(read-only). Confirm `visibleGroups`/`isTabVisible` (studio.tsx) doesn't hide it.

**Verify**:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run lint:types` → exit 0

### Step 1.4: Tests

In `packages/studio/__tests__/features/permissions/`: a test that mocks the
`rlsPolicies` admin result and asserts a covered cell shows the procedure and an
uncovered table shows the warning marker. Mirror the mocking style in the existing
schema / migrations tests (`createClient` / `createMockClient`).

**Verify**: `pnpm --filter "@cirrus/studio" run test -- permissions` → pass.

### Step 1.5: Full gate (Item 1)

**Verify** all of:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run test -- permissions` → pass
- `pnpm --filter "@cirrus/studio" run lint:types` + `lint:eslint` → exit 0
- `git grep -n "permissions" packages/studio/src/app/studio.tsx` shows the tab.

## Test plan

- **Item 1**: covered/uncovered cells render correctly from mocked `rlsPolicies`;
  roles strip renders.
- **Item 2**: probe gated on `runAsIdentity`; allow vs deny outcomes render;
  matrix → probe prefill works.
- **Item 3**: ts-morph stub + chain-append fixtures; control gated on the
  local-edit flag; destructive request refused.

## Done criteria

Machine-checkable. ALL must hold when complete (per-item subsets gate each PR):

- [ ] `pnpm run build:packages` exits 0
- [ ] `pnpm --filter "@cirrus/studio..." run build` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run test -- permissions` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run lint:types` + `lint:eslint` exit 0
- [ ] `pnpm --filter "@cirrus/advisor" run test` exits 0 (if Item 1 cross-refs
      advisor findings)
- [ ] No new worker/DO admin op for Items 1–2:
      `git grep -n "__cirrus_admin__:" packages/do/src/introspect.ts` shows no new
      entries from this plan
- [ ] No change to RLS/mask evaluation:
      `git diff --stat 05a1e9fc..HEAD -- packages/server/src/rls packages/server/src/mask`
      is empty
- [ ] `plans/README.md` status row for 025 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match the live code (drift since
  `05a1e9fc`) — especially the `rlsPolicies` result shape or the `runAs` dispatch
  signature.
- The matrix needs policy data the `rlsPolicies` RPC does not expose (e.g.
  per-role decisions) — do NOT add a new worker op silently; report what's missing
  and the minimal metadata extension needed.
- Item 3 would author the `when` predicate body, rewrite an existing procedure's
  logic, or apply a policy in a way that changes evaluation without the developer's
  edit — STOP; the scaffolder is additive stubs only.
- The probe (`runAs`) would run without the `runAsIdentity` gate, or on a
  non-loopback host — STOP; match the function runner's gating exactly.

## Maintenance notes

- The playground deliberately reuses `runAs` rather than adding a "dry-run
  authorization" op — running the real function under a forged identity is the
  truest test and avoids a second code path that could drift from real evaluation.
- The scaffolder (Item 3) shares plan 024's local-edit endpoint + capability flag
  on purpose; if 024's seam changes, update both. Keep "additive only" identical
  to 024's boundary.
- This borrows PocketBase/InstantDB's **interaction model** only. PocketBase is
  MIT and InstantDB's client is MIT, but Cirrus copies no rule-DSL or evaluator —
  the engine is Cirrus-native TS policies. Keep that distinction in any doc.
