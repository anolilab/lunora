# Plan 286 — Prune the `@lunora/do` re-export barrel down to its real consumers

**Baseline:** `071c6a29c` (2026-08-01)
**Status:** TODO
**Priority:** P3 · **Effort:** M · **Risk:** MED · **Category:** tech-debt

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise. When done, update this plan's
> row in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 071c6a29c..HEAD -- packages/do/src/index.ts api-snapshots/do.api.md packages/codegen/src/emit.ts packages/lunora/src/do.ts`
> If any of those changed, re-derive the §1 counts and the §5 demand set before
> proceeding; on a structural mismatch treat it as a STOP condition.

## 0. Headline finding

`@lunora/do`'s public barrel is almost entirely another package's API.
`api-snapshots/do.api.md` documents **311 entries**, of which **275** are
literally the line
``Re-exported from `@lunora/shard-engine` — signature tracked at its source.``
(plus 10 more re-exported from `@lunora/platform-cloudflare`; only 26 entries
are declared locally). `packages/do/src/index.ts` is a 280-line file with **59**
`export … from "@lunora/shard-engine"` statements.

Deriving actual demand (method in §1): only about **43 distinct symbols** are
imported from `@lunora/do` anywhere in the repo, plus ~9 more that the codegen
emitter can emit conditionally — a true demand set of ~52. Roughly **~230
symbols are frozen into a second package's public surface for no consumer at
all**, and every one of them has two legal import paths (`@lunora/do` vs
`@lunora/shard-engine`) with nothing pointing at the winner — the exact drift
vector the plan-114 extraction was meant to remove.

The file's **own header** states the policy this violates
(`packages/do/src/index.ts:6-10`):

```ts
// The search core moved out of this package. It used to be re-exported from
// here so `@lunora/sql-store` could reuse it, which turned two dozen internal
// contracts into permanent public API for no reason other than cross-package
// reach. `guardWriter` left for the same reason and now lives in
// `@lunora/shard-engine`, which re-exports it.
```

The complication that makes this MED risk and staged rather than a deletion:
the same file's closing comment (`:278-280`) says the surface is deliberately
frozen — "Re-exported here because `@lunora/do`'s export surface is frozen by
plan 114 §5.2 — codegen emits against it." A straight cut is a public-API
break; the plan deprecates for one alpha cycle first.

## 1. Current state (audit)

**The counts** (all verified at baseline; re-run these):

```bash
grep -c "^### " api-snapshots/do.api.md                                      # 311
grep -c 'Re-exported from `@lunora/shard-engine`' api-snapshots/do.api.md    # 275
grep -c 'Re-exported from `@lunora/platform-cloudflare`' api-snapshots/do.api.md  # 10
wc -l packages/do/src/index.ts                                               # 280
grep -c 'from "@lunora/shard-engine"' packages/do/src/index.ts               # 59
```

**The snapshot pins names, not signatures** — `api-snapshots/do.api.md` header
region, and `scripts/api-snapshot.js:22-26`: re-exports whose declarations
live in a sibling package "are pinned by name + kind + source package only;
their signature is tracked in the owning package's snapshot". So the honest
impact statement is: shard-engine **signature** churn does _not_ double-bill
`do.api.md`; what the barrel freezes is the **name set** — every one of the
275 names is a SemVer commitment of `@lunora/do`, an add/remove in
shard-engine's barrel ripples into `do.api.md` review, and consumers get two
equally-blessed import paths for the same symbol.

**The frozen-surface note and the second mirror.**
`packages/do/src/index.ts:271-280` (trailing comments):

```ts
// Observability is NOT re-exported from here. It lives in `@lunora/observability`
// and consumers import it from there directly.
// [...]
// Relocated to `@lunora/shard-engine` (host-neutral: these touch only SQL and
// the schema, never a Durable Object). Re-exported here because `@lunora/do`'s
// export surface is frozen by plan 114 §5.2 — codegen emits against it.
```

And the umbrella mirrors the whole barrel — `packages/lunora/src/do.ts:1`:

```ts
export * from "@lunora/do";
```

so `lunorash/do` (the `lunorash` package, TIER_1 in the snapshot guard) shrinks
by exactly the same set when this barrel shrinks: **two** snapshots change at
deletion time (`do.api.md`, `lunora.api.md`).

**The codegen consumer** — the generated `_generated/shard.ts` imports from
`@lunora/do` (or `lunorash/do`, per `emit.ts:88` base mapping). Golden fixture
`packages/codegen/__tests__/fixtures/simple/expected/_generated/shard.ts:4-5`:

```ts
import type {
    AdvisorProcedure,
    AdvisoryFinding,
    DatabaseWriterLike,
    DataMigrationLike,
    ExportRow,
    ImportShardResult,
    KeyRange,
    MaskPoliciesResult,
    MigrationRunResult,
    RunShardApplyCdcArgs,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RlsPoliciesResult,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    SchedulerLike,
    TransactionHeadroomTracker,
    SchemaLike,
    ShardDOState,
    ShardRankPageResult,
    SqlExec,
    StorageRulesResult,
    StudioFeaturesResult,
    SystemReaderStorageLike,
    TelemetrySink,
} from "@lunora/do";
import {
    applyCdcChanges,
    createReadFootprint,
    createShardCtxDb,
    exportShardRows,
    importShardRows,
    runDataMigration,
    runShardMigrations,
    serveRelationFanout,
    ShardDO as ShardDOBase,
} from "@lunora/do";
```

The emitter's full demand is wider than any one fixture, because parts are
conditional — `packages/codegen/src/emit.ts:3875-3914` (`buildDoTypeImports`):

```ts
/**
 * The `@lunora/do` type names the generated shard imports. The base set is always
 * present; `WorkflowsResult` / `QueuesResult` are added only when the project
 * declares workflows / queues [...] and `WriteHook` only when it has vector indexes [...]
 */
```

conditional **types**: `FlagsResult`, `QueuesResult`, `WorkflowsResult`,
`WriteHook`; and `emit.ts:4279-4283` conditional **values**:
`assertShapeShardable` (shapes), `isSourceDue` /
`pullExternalSourceIncrementalTick` / `pullExternalSourceTick` (sourced
tables), `ROOT_SHARD_NAME` (sharded vectors).

**The derived demand set at baseline — 43 grep'd + 9 conditional ≈ 52.**
This is the crux and MUST be re-derived (my numbers are a verified lead, not
the deliverable). Method:

```bash
node -e '
const { execSync } = require("child_process");
const fs = require("fs");
const files = execSync("grep -rl --include=*.ts --include=*.tsx \"@lunora/do\\\"\" packages apps examples tests templates registry scripts 2>/dev/null || true").toString().trim().split("\n").filter(Boolean);
const syms = new Set();
const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["\x27]@lunora\/do["\x27]/g;
for (const f of files) {
  if (f.includes("/dist/") || f.includes("node_modules")) continue;
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(src))) for (let s of m[2].split(",")) {
    s = s.trim().replace(/^type\s+/, "").replace(/\s+as\s+.*$/, "");
    if (s) syms.add(s);
  }
}
console.log([...syms].sort().join("\n"), "\ntotal:", syms.size);
'
```

Baseline output (43): `AdvisorProcedure AdvisoryFinding
AggregateIndexDefinitionLike DataMigrationLike DatabaseWriterLike ExportRow
ImportShardResult KeyRange MaskPoliciesResult MigrationRunResult MutationDelta
RankIndexDefinitionLike RlsPoliciesResult RunShardApplyCdcArgs
RunShardExportArgs RunShardImportArgs RunShardMigrationArgs
RunShardRankBeforeArgs RunShardRankPageArgs RunShardWriteArgs
RunShardWriteResult SchedulerLike SchemaLike SessionDO ShardDO ShardDOState
ShardRankPageResult SqlExec StorageRulesResult StudioFeaturesResult
SubscriptionOutcome SystemReaderStorageLike TelemetrySink
TransactionHeadroomTracker ValidatorLike applyCdcChanges createReadFootprint
createShardCtxDb exportShardRows importShardRows runDataMigration
runShardMigrations serveRelationFanout`

Plus (grep `emit.ts` for the current conditional lists — they may have grown):
`FlagsResult QueuesResult WorkflowsResult WriteHook assertShapeShardable
isSourceDue pullExternalSourceIncrementalTick pullExternalSourceTick
ROOT_SHARD_NAME`.

Also add anything `_generated` files in `examples/*/lunora/_generated/` import
from `@lunora/do` (the scan above covers them, but they are generated — the
emitter lists in `emit.ts` are the source of truth; the fixture and examples
must agree with them).

**Confidence calibration**: the counts are HIGH-confidence; "unused
externally" is MED — this is repo-internal evidence only. Third-party apps
built on published `@lunora/do` (e.g. ports like the anole.chat migration) may
import re-exported names directly. That is exactly why §4 chooses
deprecate-then-delete over delete.

## 2. Existing seams (do not reinvent)

- **The local/kept exports are already grouped** at the top of
  `packages/do/src/index.ts` (`:5-33` local `SessionDO`/`ShardDO`/relay
  exports, `:34-40` the platform-cloudflare composition-root re-exports); the
  shard-engine block (`:41-269`) is what gets partitioned.
- **`@deprecated` JSDoc + the snapshot's comment-stripping**
  (`scripts/api-snapshot.js:17-19`: signatures are re-printed "with comments
  removed") — deprecation annotations do NOT churn `do.api.md`, which is what
  makes Phase A snapshot-neutral and cheap to land.
- **The emitter's import builders** (`buildDoTypeImports` at `emit.ts:3881`,
  the value-import template literal at `:4283`) — the machine-readable codegen
  demand list; the kept set is defined against these, not against fixtures.
- **`pnpm run api:update` / `api:check`** — the gate that makes the eventual
  deletion an explicit, reviewed surface change (two files: `do.api.md`,
  `lunora.api.md`).
- **The file's own header comments** (`:6-10`, `:271-277`) — the policy text;
  Phase A adds the enforcement comment beside them rather than inventing new
  prose elsewhere.

## 3. The behavioural contract to preserve

- **Phase A (this plan) changes no runtime behavior and no API surface.**
  `pnpm run api:update` after Phase A must produce **zero diffs** — the same
  names, kinds, and sources; only source-file comments moved. This is
  testable and is the Phase A gate.
- The **kept set** must be a superset of: every symbol in the re-derived §1
  demand list, every name in `buildDoTypeImports` including conditionals,
  every conditional value import at `emit.ts:4283`, and all locally-declared
  exports. When in doubt, keep — the cost of keeping one extra name is one
  deprecation cycle; the cost of cutting a used one is a break.
- `lunorash/do` (`packages/lunora/src/do.ts` `export * from "@lunora/do"`)
  stays a full mirror — do not "fix" the umbrella separately; it inherits the
  deprecations and, later, the deletions automatically.
- Codegen golden fixtures and `examples/*/lunora/_generated/*` are byte-frozen
  in Phase A (no emitter change → no regen). If any fixture changes, something
  off-plan happened — STOP.
- `@lunora/do`'s deep internals (`shard-do.ts` etc.) are untouched; this plan
  edits ONLY `packages/do/src/index.ts` (and, at deletion time, snapshots).

## 4. Design decisions

**Stage the removal: deprecate one alpha cycle, then delete.** A straight
deletion was rejected because (i) the surface is _documented as frozen_ by
plan 114 §5.2 with codegen emitting against it, (ii) external-consumer
evidence is unattainable from this repo (§1 confidence note) — published
templates (`lunora init` fetches `gh:anolilab/lunora/templates/<type>#alpha`)
and third-party ports may import any of the 275 names, and (iii) the
`@deprecated`-with-pointer intermediate state costs nothing (snapshot-neutral,
§2) while giving every consumer a machine-visible migration hint
(editor strikethrough + the "import from `@lunora/shard-engine`" note).

**Deprecate by partitioning the export statements, not per-name JSDoc
gymnastics.** The barrel's 59 statements get regrouped into a KEPT block
(demand set, undecorated) and a DEPRECATED block where each `export … from`
statement carries a `/** @deprecated Import from `@lunora/shard-engine`
instead — this re-export is removed after one alpha cycle (plan 286). */`
JSDoc. Rejected alternative: renaming re-exports or wrapper aliases to attach
per-symbol docs — churns the d.ts shapes and risks snapshot diffs in Phase A.

**Define the kept set from consumers + emitter, not from taste.** The rule the
header already states — re-exports exist for codegen and for real cross-package
demand, not for reach — becomes an enforceable comment at the top of the
shard-engine block: _"Every re-export below must have a named consumer (the
codegen emitter's import builders, or an import site in this repo). Additions
require one; drive-by re-exports are how 230 unused names got frozen here
(plan 286)."_

**Do not migrate internal importers off `@lunora/do` in this plan.** Tempting
(it would shrink the demand set further — e.g. `d1`/`sql-store`/`testing`
import shard-engine names via `do`), but it multiplies the diff across ~15
packages and muddies the fail-safe property of "kept ⊇ observed demand".
Recorded as the natural follow-up once the deprecation cycle lands (§9.3).

## 5. Workstreams

### W1 (M) — Re-derive the demand set and partition `packages/do/src/index.ts`

1. Run the §1 derivation script and the emitter greps
   (`grep -n "buildDoTypeImports" packages/codegen/src/emit.ts` and read the
   array + the `:4283` template literal + `hasFlags`/`hasQueues`/etc.
   conditionals). Union = kept re-export set. Record the final list and its
   size **in this plan file** under §9.1.
2. Regroup the shard-engine block of `packages/do/src/index.ts`: kept
   statements first (uncommented beyond what exists), then the deprecated
   remainder, each statement carrying the `@deprecated` JSDoc from §4. Keep
   the platform-cloudflare re-exports (`:36-40`) untouched — they are the
   composition-root surface, not part of this cleanup (their 10 names include
   codegen-era consumers; verify with the same script filtered to those names
   before deciding otherwise, and default to keep).
3. Add the enforcement comment (§4) atop the shard-engine block.

**Verify**: `pnpm run build:packages` exit 0;
`pnpm --filter "@lunora/do" run lint:types` exit 0;
`pnpm --filter "@lunora/do" run lint:eslint` exit 0.

### W2 (S) — Prove Phase A is surface-neutral

`pnpm run api:update` then `git diff --stat api-snapshots/` → **empty**. If
`do.api.md` or `lunora.api.md` changed, a name was dropped or re-shaped — STOP
per §8, do not hand-tune the snapshot.

### W3 (S) — Consumer sweep sanity

Full builds and the heaviest consumers' suites, because the barrel's shape
(statement grouping) changed even though its name set didn't:

- `pnpm --filter "@lunora/do" run test`
- `pnpm --filter "@lunora/runtime" run test`
- `pnpm --filter "@lunora/codegen" run test` (golden fixtures byte-frozen)
- `pnpm --filter "lunorash" run test` (umbrella mirror)

**Verify**: all pass; `git status` shows only `packages/do/src/index.ts` (and
this plan file) modified.

### W4 (S) — Schedule the deletion (follow-up, do NOT execute here)

Record in `plans/README.md` (or a follow-up plan stub if the operator prefers)
the deletion condition: after one alpha release cycle of `@lunora/do`
containing the deprecations, delete the deprecated block, run
`pnpm run api:update`, and review the `do.api.md` + `lunora.api.md` diffs as
the explicit ~230-name public-API removal, with a changelog-visible
`feat`/`refactor` commit (a breaking-change footer per the repo's semantic
release conventions). The deletion inherits this plan's STOP conditions —
especially §8's external-import check, re-run at that time.

## 6. Platform parity

**Not applicable.** This plan reshapes a re-export barrel; no `ctx.*` surface,
binding, or deploy/runtime capability changes, and every affected symbol
remains available at its source package (`@lunora/shard-engine`) on every
host. No `PlatformCapabilities` row changes.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                |
| ----- | ---- | ----------------------------------------------------------------------------------- |
| 1     | W1   | build + lint:types + lint:eslint green on `@lunora/do`                              |
| 2     | W2   | `pnpm run api:update` → `git diff api-snapshots/` empty (surface-neutrality proven) |
| 3     | W3   | do / runtime / codegen / lunorash suites green; codegen fixtures byte-identical     |
| 4     | W4   | Deletion condition recorded (README row or follow-up stub) — not executed           |

## Commands you will need

| Purpose          | Command                                      | Expected                     |
| ---------------- | -------------------------------------------- | ---------------------------- |
| Build deps       | `pnpm run build:packages`                    | exit 0                       |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types`  | exit 0                       |
| Lint             | `pnpm --filter "@lunora/do" run lint:eslint` | exit 0                       |
| Snapshot regen   | `pnpm run api:update`                        | exit 0, zero diff in Phase A |
| Snapshot gate    | `node scripts/api-snapshot.js check`         | exit 0                       |
| Tests (do)       | `pnpm --filter "@lunora/do" run test`        | all pass                     |
| Tests (runtime)  | `pnpm --filter "@lunora/runtime" run test`   | all pass                     |
| Tests (codegen)  | `pnpm --filter "@lunora/codegen" run test`   | all pass                     |
| Tests (umbrella) | `pnpm --filter "lunorash" run test`          | all pass                     |

Note: whole-repo `pnpm -r test` is flaky in this repo (per project memory) —
use the per-package filters above or `pnpm run test:affected`.

## Scope

**In scope:**

- `packages/do/src/index.ts` — regrouping, `@deprecated` JSDoc, enforcement
  comment. Names: unchanged.
- This plan file (recording the derived kept set, §9.1)
- `plans/README.md` — status row + the W4 deletion note

**Out of scope:**

- Deleting anything (Phase B, after one alpha cycle — W4 records it)
- `packages/lunora/src/do.ts` — the `export *` mirror stays
- `packages/codegen/src/emit.ts` and all fixtures/`_generated` output
- `packages/shard-engine/**` — the owning package is correct
- Migrating internal importers from `@lunora/do` to `@lunora/shard-engine`
  (§9.3 follow-up)
- `api-snapshots/*` — must be byte-identical in Phase A (regenerated only to
  prove it)

## Git workflow

- Branch: `advisor/286-do-reexport-barrel`
- Conventional commit, e.g. `refactor(do): deprecate unused shard-engine re-exports behind their source package`
  (`dx` is not an enforced type; `refactor` fits Phase A — no behavior change).
- Shared checkout: stage `packages/do/src/index.ts` explicitly; it is a
  hot file — per-hunk staging if another session touched it.
- Do NOT push or open a PR unless the operator asked for it.

## Test plan

Phase A adds no new behavior, so the "fail against pre-fix code" requirement
maps onto the surface-neutrality proof and the deprecation visibility check:

1. **Surface-neutrality (the load-bearing check)**: `pnpm run api:update` →
   zero snapshot diff. Run it once _mid-work_ with a deliberately dropped name
   (scratch: comment out one kept re-export) to see the gate FAIL and name the
   symbol in `do.api.md` — proving the gate would catch a wrong partition —
   then restore. Capture both outputs.
2. **Deprecation is visible where it should be**: after building, confirm the
   emitted `packages/do/dist/*.d.ts` carries the `@deprecated` JSDoc on a
   sampled deprecated re-export (grep the dist d.ts for `@deprecated`), and
   that a scratch `import { <deprecated name> } from "@lunora/do"` in a
   consumer package produces an editor/tsc deprecation strikethrough (tsc
   does not error on deprecated — visual/`eslint`-level check only; note what
   you observed).
3. **No consumer regression**: the four suites in W3 pass.
4. **Fixture freeze**: `git status packages/codegen/__tests__/fixtures/` clean.

## Done criteria

ALL must hold:

- [ ] Re-derived kept set recorded in §9.1 (list + count), superset of the §1 baseline list + emitter conditionals
- [ ] Every non-kept shard-engine re-export statement in `packages/do/src/index.ts` carries the `@deprecated` JSDoc with the shard-engine pointer
- [ ] Enforcement comment present atop the shard-engine block
- [ ] `pnpm run api:update` produces zero diff; `node scripts/api-snapshot.js check` exits 0
- [ ] Scratch-drop gate demonstration captured (test plan 1)
- [ ] `pnpm --filter "@lunora/do" run lint:types` and `run test` exit 0; same for runtime, codegen, lunorash suites
- [ ] `packages/codegen/__tests__/fixtures/` byte-identical (`git status` clean)
- [ ] W4 deletion condition recorded
- [ ] `git status` shows no files modified outside the in-scope list
- [ ] `plans/README.md` status row updated

## 8. Risks & STOP conditions

- **STOP** if any published example, template, or `registry/` item imports a
  symbol outside the kept set (`grep -rn 'from "@lunora/do"' examples
templates registry` beyond the `_generated` files the emitter owns) — widen
  the kept set rather than deprecating a consumed name, and record the
  consumer in §9.1.
- **STOP** if Phase A's `api:update` shows ANY diff in `do.api.md` or
  `lunora.api.md` — a name was lost or a kind changed; find it, do not commit
  a snapshot update in this plan.
- **STOP** if the codegen suite or any golden fixture changes — the emitter
  demand list was mis-read; re-derive against `emit.ts` (including every
  `has*` conditional) before continuing.
- **STOP** if plan 114 §5.2's freeze turns out to be enforced by an artifact
  this plan hasn't accounted for (e.g. a surface-list test beyond the api
  snapshots — search `packages/do/__tests__` for export-name assertions
  before starting; none was found at baseline, but the memory of a "305-name
  frozen surface check" from the shard-do split suggests one may have existed
  or may return). Reconcile with its owner rather than editing the check.
- **Risk:** the deprecated block silently regrows (new drive-by re-exports).
  Mitigate: the enforcement comment (W1.3) plus the eventual deletion; if the
  operator wants a hard guard, note a follow-up to lint re-export additions in
  §9.4 — do not build it in this plan.
- **Risk:** MED-confidence external usage (§1). Mitigate: that is what the
  deprecation cycle is _for_ — external consumers get a full release cycle of
  visible warnings before Phase B deletes anything.

## 9. Open questions (answer during execution)

1. **The final kept set** (record list + count here after W1.1). Baseline
   lead: 43 grep-derived + 9 emitter-conditional = 52, plus all locally
   declared and the 10 platform-cloudflare names.
2. Should the 10 `@lunora/platform-cloudflare` re-exports (`index.ts:36-40`)
   join the deprecation, pointing consumers at `@lunora/platform-cloudflare`
   directly? Default here: keep (the comment at `:34-35` presents them as this
   package's intended host surface) — confirm with the demand script and
   record.
3. Follow-up: migrate internal importers (`d1`, `sql-store`, `testing`,
   `studio`, …) from `@lunora/do` to `@lunora/shard-engine` so the kept set
   can shrink toward the codegen-only core. File as its own plan after the
   deprecation cycle.
4. Does the operator want a mechanical guard against new un-consumed
   re-exports (a check script diffing barrel names against a recorded
   consumer map), or is the comment + snapshot review enough? Record the
   decision.

---

## 10. Execution finding — the deprecation signal does not reach consumers

**Phase A landed correctly and is provably surface-neutral** (`api:update` produced
a byte-identical `do.api.md` _and_ `lunora.api.md`; a deliberate scratch-drop of one
kept name made the gate fail in both, proving it would catch a wrong partition).
Kept set: **52 names** (43 grep-derived + 9 emitter-conditional), matching this
plan's lead exactly — no widening needed. 237 names now carry `@deprecated` in
source.

**But the `@deprecated` JSDoc is dropped from the built types.** Verified:

```
grep -c "@deprecated" packages/do/src/index.ts        → 57
grep -c "@deprecated" packages/do/dist/index.d.mts    → 1   (a pre-existing alias
                                                             rename on a LOCAL
                                                             declaration, unrelated)
```

Cause, isolated with a 2-file `tsc --declaration` repro: plain `tsc` **does**
preserve JSDoc on a bare `export { … } from "…"` statement, but packem's dts
bundler merges every same-specifier re-export into one combined statement and
drops the individual leading comments.

Consumers resolve through `dist` — in-repo (per this repo's stale-`dist`
convention) and from npm. So **no consumer will see a deprecation strikethrough**.
§4 chose the staged deprecation specifically to give people one alpha cycle of
warning before a ~237-name removal; as built, that cycle delivers calendar time
and no signal.

### The decision W4 now has to make

1. **Accept it as source-only.** The annotation documents intent for anyone
   reading `packages/do/src/index.ts`, and the deletion still gets a
   breaking-change footer. Cheapest, but the warning never reaches the people it
   was for.
2. **Fix the dts bundling.** Investigate whether packem/`rollup-plugin-dts` can
   preserve per-statement comments (note this repo pins `rollup-plugin-dts` to
   classic 6.0.3 via a `.pnpmfile.cjs` hook — see the TS7 memo — so an upgrade is
   not free). Highest value if cheap.
3. **Skip the cycle.** If the warning cannot be delivered, a one-cycle wait buys
   nothing; delete in one deliberate breaking change with release notes instead of
   pretending consumers were warned.

**Recommendation: (2) if a bundler option exists, else (3).** Option 1 is the
worst of both — it pays the cost of a deprecation cycle without its benefit.

Answer this before starting W4; do not begin the deletion on the assumption that
consumers have been warned.
