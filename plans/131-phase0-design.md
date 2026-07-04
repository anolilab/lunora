# Plan 131 — [Spike] Advisor autofix + suppression/baseline design

> **Status: DESIGN/SPIKE — not implemented.** Priority P2, Effort L (spike M), Risk
> spike low / eventual MED, Depends on none, Category dx. Planned at `b6eb48dcd`.
> This document is the Step-5 deliverable; two throwaway prototypes under
> `packages/codegen/src/__prototype__/` de-risk the two load-bearing claims (a real
> AUTOFIX-SAFE fixer, a real suppression/baseline path) before any of this is built
> for real. Branch `advisor/131-autofix-baseline-spike`.

## 0. The problem

`@lunora/advisor` ships 83 lints (80 static + 3 runtime — see §0.1) across schema
shape, RLS/auth, ratelimiting, storage, containers, AI, payments, mail, and general
security. On a greenfield app this is fine: fix findings as they appear. On a
**brownfield** app — an existing schema with years of accumulated shape, or a
schema intentionally diverging from a lint's assumption — a strict/CI-gated advisor
run is all-or-nothing: either every finding gets fixed today, or the whole lint set
gets disabled to unblock CI, which is how the checked-in comment in
`packages/advisor/src/index.ts` describing 80 rules quietly rots to "23 of them
still fire, nobody remembers why the rest don't." Two missing capabilities close
this gap:

1. **Autofix** for the subset of lints where a fix has one unambiguous, mechanical,
   safe-direction shape — so brownfield adoption doesn't require a manual pass over
   every finding.
2. **Suppression/baseline** for everything else — so a team can acknowledge "we
   know, and it's fine" with an audit trail, instead of disabling the lint (which
   also hides _future_, different instances of the same problem).

### 0.1 Lint census (verified against source, not estimated)

```
$ find packages/advisor/src/lints/static -maxdepth 1 -name "*.ts" | wc -l
81
$ grep -oP '(?<=from "\./lints/static/)[a-z0-9-]+(?=")' packages/advisor/src/index.ts | sort -u | wc -l
80
```

`packages/advisor/src/lints/static/fk-index.ts` is the one file not imported into
`packages/advisor/src/index.ts`'s `STATIC_LINTS` array — it exports shared helpers
(`PRIMARY_KEY`, `suggestIndexName`, `leadingIndexedColumns`) consumed by several
real lints, but is not itself a `Lint`. So: **80 static lints + 3 runtime lints
(`hot-shard`, `index-utilization`, `constraint-validator`) = 83 total registered
lints**, drawn from 81 static + 3 runtime = 84 disk files. This document's
classification table (§1) covers all 80 static lints; the 3 runtime lints are noted
separately (§1.4) since they fire from observed traffic, not `defineSchema`, and
none are autofixable by construction.

## 1. Step 1 — Fixability classification (all 80 static lints)

Three buckets:

- **AUTOFIX-SAFE** — the fix has one unambiguous code shape, is a pure text edit to
  `lunora/schema.ts` (or a sibling `lunora/*.ts` file), and applying it can only
  ever _add_ correctness (an index, never remove a constraint) — safe to apply
  without a human confirming the specific value.
- **ASSISTED** — the fix's _code shape_ is knowable (a specific line/toggle/call to
  add), but the _value_ needs a human: a rate-limit window, a max-size bound, a
  cookie-security flag that's legitimately off in local dev, a hash strategy
  upgrade. These get a suggested diff and a confirm step, never a blind apply.
- **ADVISORY-ONLY** — either the fix shape itself is ambiguous (a broken relation
  reference could mean "fix the table name" or "the table is genuinely missing"),
  or a wrong default is actively dangerous (auth guards, RLS policy shape, secret
  handling, SSRF allowlists) — surface the finding, do not suggest code.

Two family-level rules, applied uniformly rather than lint-by-lint, because a
mixed verdict within one family is worse than a debatable verdict applied
consistently:

- **Arg-derived-sink family** (`kv-unscoped-user-key-idor`,
  `container-instance-key-from-user-input`, `vectors-namespace-from-user-input`,
  `storage-key-from-user-args`, `images-url-source-from-user-input`,
  `browser-user-url-without-allowlist`, `mail-recipient-from-request-input`) — all
  **ADVISORY-ONLY**. The shared shape is "an identity/scope-selection value is
  taken from user-controlled args instead of `ctx.auth`." The correct fix is
  case-specific (sometimes the arg genuinely should scope a _public_ resource;
  sometimes it's a real IDOR) and a wrong auto-fix fails _silently_ — the app keeps
  working, just with the wrong tenant's data. Silent-failure-mode risk disqualifies
  a family from ASSISTED regardless of how mechanical the patch text looks.
- **Secure-default-toggle family** (`auth-csrf-check-disabled`,
  `auth-email-verification-disabled`, `auth-secure-cookies-disabled`,
  `auth-session-freshage-zero`, `ratelimit-middleware-fail-open`) — all
  **ASSISTED**. The shared shape is "a boolean/numeric config flag is set to the
  insecure value"; flipping it to the secure default is a one-line, reversible,
  loudly-visible config change (unlike the arg-derived-sink family, an accepted-then
  -wrong suggestion here fails _loudly_: local dev breaks immediately if secure
  cookies get force-enabled without HTTPS, so the failure mode is a build/dev-server
  error, not silent data leakage) — hence ASSISTED (confirm), not AUTOFIX-SAFE
  (no blind apply — dev-mode opt-outs are frequently intentional).

### 1.1 AUTOFIX-SAFE (4: 3 hard + 1 soft)

| Lint                        | Fix shape                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unindexed-foreign-key`     | Append `.index(suggestedName, [field])` to the table whose `.relations()` declares an unindexed FK field. **Prototyped in §4.1.**                                                                                                                                                   |
| `unindexed-relation-target` | Same shape as above, mirrored onto the relation's target table/field.                                                                                                                                                                                                               |
| `duplicate-index`           | Remove the redundant `.index(...)` call (same fields, same or looser uniqueness) — pure deletion, never changes queryable shape.                                                                                                                                                    |
| `empty-index` (soft)        | Remove an `.index(name, [])` call with a genuinely empty field list. Marked _soft_ because an empty array is more often a scaffolding placeholder mid-edit than a finished mistake — safe to auto-remove, but worth a `--dry-run` default in the CLI rather than silent-by-default. |

Naming a suggested index requires a name, and this is where the one open blocking
question in this whole design lives — see §5.1. The fixer prototype (§4.1) sidesteps
it by using the existing (if inconsistent) `suggestIndexName` helper as-is; a real
feature should not ship until §5.1 is resolved, since it determines the string this
whole bucket writes into every brownfield schema.

### 1.2 ASSISTED (19)

| Lint                                              | Fix shape (suggested, confirm before apply)                                                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filter-without-index`                            | Suggest an `.index()` matching the discovered filter's field(s); target name/fields need the human to confirm this is the right index (vs. broadening an existing one).                                          |
| `queue-without-dlq`                               | Suggest wiring a DLQ queue onto the producer; needs resource provisioning, not just a text edit. **Prototyped as the suppressed finding in §4.2 instead of fixed** — a legitimate reason to acknowledge-not-fix. |
| `workflow-duplicate-step-name`                    | Suggest a disambiguated step name; renaming could affect other references, so confirm.                                                                                                                           |
| `mask-weak-hash-strategy-on-pii`                  | Suggest swapping a named weak hash (e.g. `sha1`) for a stronger named one (e.g. `sha256`/`argon2`); the target algorithm is a policy call.                                                                       |
| `auth-csrf-check-disabled`                        | Flip to the secure default. _(secure-default-toggle family, §1)_                                                                                                                                                 |
| `auth-email-verification-disabled`                | Flip to the secure default. _(secure-default-toggle family)_                                                                                                                                                     |
| `auth-secure-cookies-disabled`                    | Flip to the secure default. _(secure-default-toggle family)_                                                                                                                                                     |
| `auth-session-freshage-zero`                      | Set a non-zero default `freshAge`; exact value is a policy choice.                                                                                                                                               |
| `ratelimit-default-memory-store`                  | Suggest swapping the in-memory store for a durable one; changes a binding/resource, confirm.                                                                                                                     |
| `ratelimit-middleware-fail-open`                  | Flip to fail-closed. _(secure-default-toggle family)_                                                                                                                                                            |
| `public-mutation-without-ratelimit`               | Suggest attaching a default ratelimit middleware call; the rate/window is a policy call.                                                                                                                         |
| `storage-generate-upload-url-no-content-type-pin` | Suggest pinning an explicit content-type; the allowlist is app-specific.                                                                                                                                         |
| `storage-upload-without-content-type-allowlist`   | Same shape as above.                                                                                                                                                                                             |
| `storage-upload-without-max-size`                 | Suggest a default max-size bound; exact bound is app-specific.                                                                                                                                                   |
| `ai-unbounded-generation-public`                  | Suggest adding a max-tokens/length bound; exact bound is app-specific.                                                                                                                                           |
| `payment-webhook-wide-tolerance`                  | Suggest narrowing the timestamp-tolerance window; exact value is a policy choice.                                                                                                                                |
| `container-oversized-instance`                    | Suggest a smaller instance type; the right size is workload-specific.                                                                                                                                            |
| `public-argument-uses-any`                        | Suggest a narrower validator inferred from usage sites; correctness of the inferred shape needs a human look.                                                                                                    |
| `unbounded-string-argument`                       | Suggest adding `.max(N)`; exact bound is app-specific.                                                                                                                                                           |

### 1.3 ADVISORY-ONLY (57)

Grouped by theme (fix shape is ambiguous, or a wrong default is actively unsafe —
no suggested code, finding + explanation only):

- **Schema shape, ambiguous target** (fixing the wrong side is plausible):
  `circular-fk`, `external-source-on-global`, `external-source-unscoped`,
  `index-references-unknown-field`, `policy-references-unknown-table`,
  `relation-references-unknown-field`, `relation-references-unknown-table`,
  `shape-targets-global-table`, `shape-unknown-table`, `table-without-insert`,
  `workflow-unknown-target`, `workflow-unused`.
- **RLS / identity / authorization** (wrong default is a silent access-control
  hole): `allow-unauthenticated-shard-access-enabled`,
  `identity-undeclared-claim-trusted`, `masked-relation-leak-via-with`,
  `mask-uncovered-pii-column`, `mutator-full-row-replace`,
  `normalize-id-used-as-authorization`, `output-projection-missing-on-public-read`,
  `owner-field-from-args-not-auth`, `public-table-rls-optout-confusion`,
  `rls-uncovered-table`, `soft-delete-include-deleted-from-args`.
- **Auth config needing origin/provider knowledge**: `auth-api-call-without-headers`,
  `auth-trusted-origins-wildcard`.
- **Ratelimit key/provider decisions**: `ratelimit-key-spoofable-or-global`,
  `user-creating-mutation-without-captcha`.
- **Arg-derived-sink family** (§1, uniform rule): `kv-unscoped-user-key-idor`,
  `container-instance-key-from-user-input`, `vectors-namespace-from-user-input`,
  `storage-key-from-user-args`, `images-url-source-from-user-input`,
  `browser-user-url-without-allowlist`, `mail-recipient-from-request-input`.
- **Storage privacy decision**: `storage-presigned-url-for-private-content`.
- **HTTP/action surface, needs control-flow or policy rewrite**:
  `http-action-missing-auth-guard`, `http-action-response-header-injection`,
  `hyperdrive-outside-action`, `r2sql-outside-action`, `action-fetch-ssrf`,
  `admin-route-without-guard`, `browser-allow-private-targets`.
- **AI safety**: `ai-raw-run-escape-hatch`, `ai-tool-side-effect-prompt-injection`.
- **Payments flow**: `payment-create-without-authorize`.
- **Mail verification**: `mail-inbound-dispatch-without-verify`.
- **Flags**: `flag-gates-security-with-unsafe-default`.
- **Container network policy**: `container-public-internet`,
  `container-runtime-egress-relaxation`, `container-start-enable-internet-override`.
- **General security / correctness**: `sql-injection-risk`, `hardcoded-secret`,
  `plaintext-secret-in-wrangler-variables`, `privileged-dispatch-unvalidated-payload`,
  `privileged-fanout-from-public-procedure`, `nondeterministic-query-mutation`,
  `insert-many-unsafe-user-data`.

Tally check: 3 hard + 1 soft AUTOFIX-SAFE + 19 ASSISTED + 57 ADVISORY-ONLY = 80. ✓

### 1.4 Runtime lints (3, informational)

`hot-shard`, `index-utilization`, `constraint-validator` fire from observed
production traffic (scan attribution), not from static `defineSchema` analysis.
None are autofixable by construction — there is no "schema patch" a fix could write
that would change already-observed runtime behavior; the finding itself _is_ the
signal that a human should look at query patterns or add an index (which, if it's
the `unindexed-foreign-key` shape, routes back through §1.1 once the human adds the
relation). Out of scope for autofix; in scope for the same baseline/suppression
mechanism as the static lints (§3), since they use the same `Finding`/`cacheKey`
contract (confirmed in `packages/advisor/src/index.ts`'s `ALL_LINTS`).

### 1.5 Independent classification cross-check

The classification above was not the only full pass over the 80 static lints. An
independent classification of the same lint set — produced by four parallel
classifier sessions with per-lint fix shapes, forwarded in batches during this
spike, coordinated and spot-verified by the reviewing session — reached **3
AUTOFIX-SAFE / 33 ASSISTED / 44 ADVISORY-ONLY** against this doc's **4 (3 hard +
1 soft) / 19 / 57**. Where the two passes stand relative to each other:

- **The hard AUTOFIX-SAFE sets agree exactly**: both passes independently landed
  on `duplicate-index`, `unindexed-foreign-key`, `unindexed-relation-target` as
  the only blind-apply-safe lints, and the external pass also flagged
  `empty-index` as the same soft 4th candidate this doc does (§1.1).
- **The entire delta (~14 lints) is in the ASSISTED↔ADVISORY middle band.** The
  external pass scored each lint individually and rated
  "single-decision-but-risky" cases ASSISTED; this doc's family-uniform rules
  (§1) demote several of those to ADVISORY-ONLY as a family. Concrete examples,
  all external-ASSISTED → this-doc-ADVISORY: `kv-unscoped-user-key-idor` (via
  the arg-derived-sink family rule — the external pass itself split that family
  5 ADVISORY vs 1 ASSISTED, which is precisely the inconsistency the family rule
  exists to eliminate), `owner-field-from-args-not-auth`,
  `output-projection-missing-on-public-read`, and `mask-uncovered-pii-column`
  (silent access-control/identity failure modes, per §1.3's RLS grouping). One
  reclassification went the other direction:
  `mask-weak-hash-strategy-on-pii` moved to ASSISTED here, agreeing with the
  external call over this spike's own earlier draft judgment.
- **What the agreement and the disagreement each mean.** Two independent full
  passes converging on the same tiny SAFE set materially strengthens the §2.5 /
  §6 scoping of blind `--fix` to exactly those lints — that boundary is not one
  session's taste. And the fact that the _only_ meaningful divergence is
  ASSISTED-vs-ADVISORY in the debatable middle is itself evidence that this
  boundary cannot be left to per-lint judgment calls: it needs the written,
  per-family rules this doc establishes (§1), which any future lint must be
  classified against rather than scored fresh.

## 2. Step 2 — Fixer architecture

### 2.1 Package boundary

The fixer lives in **`@lunora/codegen`**, not `@lunora/advisor`. Two reasons,
confirmed against `packages/codegen/package.json`:

1. `@lunora/codegen` already depends on `@lunora/advisor` (`"@lunora/advisor":
"1.0.0-alpha.19"` in `dependencies`) — the reverse edge would be circular.
2. codegen already owns the one thing a schema-file fixer needs: a ts-morph
   `Project` over `lunora/schema.ts` (`createCodegenProject`/`refreshCodegenProject`
   in `packages/codegen/src/run-codegen.ts`) and the `lintSchema` feeder
   (`packages/codegen/src/advisor.ts`) that turns the IR into `LintContext`. A
   fixer is naturally "one more thing codegen's `Project` does before/after a
   normal codegen run," not a new subsystem.

### 2.2 Mechanism: AST-merge, not string-patching

Precedent already exists in the repo: `.vis/templates/_helpers/insert-table.ts`'s
`insertTableIntoSchema` — in-memory ts-morph `Project`, locate the `defineSchema`
`CallExpression`, get its object-literal argument, find the target table's
`PropertyAssignment` by name, mutate via `setInitializer`/`addPropertyAssignment`,
return `sourceFile.getFullText()`. The fixer prototype (`appendIndexFix` in
`plan-131-fixer-poc.ts`, §4.1) follows this exact shape for appending
`.index(...)` onto a table's existing method chain. A real fixer's per-lint
"patch function" is this same pattern, parameterized by lint `cacheKey` shape:

```ts
type Fixer = (project: Project, finding: Finding) => { applied: boolean };
```

### 2.3 Idempotence and conflict rules

Demonstrated in the prototype and required of any real fixer:

- **Idempotent by construction**: before mutating, check whether the target text
  (`.index("byCreatedBy"` in the PoC) already appears in the property's
  initializer text; if so, no-op (`{ changed: false }`). Verified empirically —
  re-running the fixer PoC a second time against the already-fixed schema reports
  "target finding not present... Exiting" rather than double-appending.
- **Fails loud, never partial-writes**: `appendIndexFix` throws (rather than
  silently skipping) if `defineSchema(...)` or the named table can't be found —
  a real fixer must not write a file it only partially understood.
- **One write, then re-lint**: apply the fix to the in-memory `Project`, get
  `getFullText()`, Prettier-format it (§2.4), write to disk once, then re-run
  `runCodegen`/`lintSchema` to confirm the specific finding is gone — never trust
  the fixer's own "I fixed it" claim without an independent re-lint (this is
  exactly what both prototypes do, and what caught the `tablesObject` narrowing
  bug during this spike's own type-check pass).

### 2.4 Prettier guarantee

Every fixer writes through `prettier.format(text, await prettier.resolveConfig(path))`
before touching disk — demonstrated in `plan-131-fixer-poc.ts`, independently
verified via a separate `prettier --check` invocation (not just trusting the
script's own formatting step). This matters because AST mutation via
`setInitializer(string)` inserts the new text as one line; without a Prettier pass
the diff would be unreadable and would fail the repo's pre-commit `vis staged`
Prettier check.

### 2.5 Invocation surface (recommendation, not built this spike)

Two distinct UX shapes for the two buckets in §1, matching the plan's own STOP
condition — see §5.2 for why:

- **AUTOFIX-SAFE (§1.1, 4 lints)**: a narrow `lunora codegen --fix` (or a dedicated
  `lunora advisor fix`) flag that applies all AUTOFIX-SAFE fixes blindly, then
  re-lints and prints a diff summary. Small enough surface that blind-apply is
  defensible — every fix in this bucket only ever adds an index.
  Gated on §5.1 (the naming-convention question) before shipping, since the
  written string is user-facing and hard to walk back once brownfield apps have it
  in their schema.
- **ASSISTED (§1.2, 19 lints)**: an interactive `lunora advisor fix --interactive`
  (studio equivalent: a "Suggest fix" button next to each ASSISTED finding in
  `AdvisorView`, alongside the existing `ApplyIndexButton` confirm-before-apply
  clipboard-copy pattern in `packages/studio/src/features/advisors/apply-index-button.tsx`)
  that shows the suggested diff and requires an explicit confirm per finding. This
  is the larger, more valuable feature — 19 lints vs. 4 — and should be the
  headline feature of a real implementation, not the blind `--fix`.

## 3. Step 3 — Suppression / baseline design

### 3.1 Existing mechanism check (STOP-condition guard)

Before designing anything: `packages/advisor/src/index.ts`'s `runAdvisor(context,
options: { lints?, source? })` has **no** suppression/baseline option today, and no
inline-comment-based suppression exists either — `getLeadingCommentRanges()` (the
ts-morph API a `// lunora-advisor-ignore` convention would need) has zero call
sites in `packages/advisor/src/` or `packages/codegen/src/`. Confirmed by direct
search, not assumed. So this is genuinely new design, not a rediscovery of
something already shipped — the STOP condition ("existing suppression mechanism
missed") does not trigger.

### 3.2 Two candidate shapes, and why one is primary

- **Inline directive** (`// lunora-advisor-ignore: unindexed_foreign_key`,
  attached via `getLeadingCommentRanges()` on the relevant AST node) — deferred,
  not designed further this spike. It requires codegen's lint-context builder
  (`lintSchema` in `packages/codegen/src/advisor.ts`) to thread source positions
  from the IR back to `Finding`s, which it does not do today (`Finding` carries a
  `cacheKey`, not a source span) — genuinely net-new plumbing, not a small
  addition. Also weaker for audit trail: a comment has no structured
  who/when/why, and grep-based drift (comment silently pointing at deleted code)
  is a known failure mode of this pattern elsewhere.
- **Baseline file** (recommended primary path, prototyped in §4.2): a
  `lunora/advisor-baseline.json` keyed by the finding's existing, stable
  `cacheKey` (already used for reactive diffing — confirmed format
  `unindexed_foreign_key:channels:createdBy`,
  `queue_without_dlq:notifications`, from
  `packages/advisor/src/lints/static/queue-without-dlq.ts:62`). Each entry carries
  a structured audit trail (`acknowledgedBy`, `acknowledgedAt`, `reason`) — no new
  source-position plumbing needed, since it keys off data the `Finding` contract
  already guarantees.

### 3.3 Where filtering happens — the constraint that shapes everything

`Finding[]` is not just an ephemeral CLI/studio display value. Static findings are
baked at **codegen time** into a generated `LUNORA_ADVISORIES` literal
(`packages/codegen/src/emit.ts`, confirmed ~line 3598) and served at runtime via
the `__lunora_admin__:getAdvisories` RPC (`packages/do/src/introspect.ts`) —
**without the Durable Object depending on `@lunora/advisor`**. This means baseline
filtering **must** happen at or before codegen time, never at render/serve time —
by the time `LUNORA_ADVISORIES` is written into `_generated/*`, the baseline has
already had to apply, or the suppressed finding ships into the deployed worker's
generated code regardless of what the CLI prints.

Consequence: `applyBaseline` (prototyped, §4.2) is a **pure filter**
(`(findings, baseline) => { findings, suppressed }`) called at the `lintSchema(...)`
call site inside codegen — not a change to `runAdvisor` itself. This was a
deliberate scope decision (documented in the prototype's own header comment): the
shipped `runAdvisor(context, options)` signature stays untouched; a real feature
would either (a) add an optional `baseline` option to `RunAdvisorOptions` that
`runAdvisor` applies internally (cleanest call-site ergonomics, but touches the
package other tools also import), or (b) keep it as an external wrapper the CLI/
codegen entry points call explicitly (zero risk to `runAdvisor`'s existing
callers, but two call sites — CLI codegen handler and `lintSchema` — must both
remember to call it). This design leans (b) for the same reason the prototype
does: it's the smaller, more reversible change, and matches how `formatAdvisories`
already sits _beside_ `runAdvisor` rather than inside it.

### 3.4 cacheKey stability

The baseline's entire audit trail is worthless if `cacheKey` drifts across
unrelated schema edits (an entry silently stops matching, the finding "reappears"
with no code change, or worse, a _different_ finding coincidentally collides with
a stale entry). Confirmed stable by construction: every lint's `cacheKey` is built
from stable identifiers already required to exist in the schema — table names,
field names, index names (`unindexed_foreign_key:channels:createdBy`,
`queue_without_dlq:notifications`) — not line numbers or source hashes. Renaming a
table or field changes the cacheKey (correctly invalidates the baseline entry,
surfacing the finding again for the new name) but reformatting the file, reordering
tables, or adding unrelated tables does not. This was independently re-verified
this spike (not just assumed) by running the fixer PoC — which prettier-reformats
the whole file — followed by a re-lint, and confirming `queue_without_dlq:notifications`
survives unchanged both before and after (§4.2's baseline PoC ran against the
already-fixed schema and still matched the same cacheKey it was written against).

### 3.5 Baseline file shape (as prototyped)

```json
{
    "entries": [
        {
            "cacheKey": "queue_without_dlq:notifications",
            "reason": "Fire-and-forget notifications queue — message loss on exhausted retries is acceptable per the queue's own doc comment in lunora/queues.ts. Acknowledged rather than fixed.",
            "acknowledgedBy": "d.bannert@anolilab.de",
            "acknowledgedAt": "2026-07-04T00:00:00.000Z"
        }
    ]
}
```

`reason` is required (not optional) in any real implementation — an unattributed
suppression is exactly the "disable the whole lint, nobody remembers why" failure
mode this design exists to avoid, just scoped to one finding instead of one lint.

## 4. Step 4 — Prototype proofs

Both prototypes live at `packages/codegen/src/__prototype__/` (not part of the
package's public API — nothing under `src/index.ts` imports that directory),
runnable directly via `node --experimental-strip-types` (Node 24 supports native
type-stripping; no build step). Both self-import `@lunora/codegen`'s own **built**
public entry (`import { runCodegen } from "@lunora/codegen"`) rather than reaching
into source — Node's real ESM loader can't resolve the package's internal
extensionless relative imports without a build step, and this is also more
representative of how a real fixer feature would consume codegen, through its
public API. Both are Prettier-clean, ESLint-clean (package's own flat config, one
narrowly-scoped override added for `import/no-extraneous-dependencies` — see
`packages/codegen/eslint.config.js`), and `tsc --noEmit`-clean.

Spike residue to delete WITH the prototypes when this branch's throwaway code
is removed: the `prettier` devDependency in `packages/codegen/package.json`,
the `**/__prototype__/**` override in `packages/codegen/eslint.config.js`, and
the `"@lunora/codegen" → ./src/index.ts` `paths` mapping in
`packages/codegen/tsconfig.json` (added so `tsc --noEmit` passes on a fresh
checkout despite the prototypes' self-import of the built package entry). All
three exist only to host the PoCs.

### 4.1 Fixer proof — `plan-131-fixer-poc.ts`

Target: `unindexed_foreign_key` against a **temp copy** of `apps/playground` —
the PoC is self-fixturing and never writes to the repository working tree. It
copies the playground (minus `node_modules`/`.lunora`/`dist`) into a
`mkdtemp` directory, injects a real `.relations()` declaration onto `channels`
there (its `createdBy: v.id("users")` column exists in the genuine schema; the
lint requires an explicit relation — confirmed empirically, it does not infer
FKs from `v.id()` alone), and runs the before/fix/after loop against the copy:

```diff
     .global()
-    .index("by_name", ["name"], { unique: true }),
+    .index("by_name", ["name"], { unique: true })
+    .relations((r) => ({
+        creator: r.one("users", { field: "createdBy" }),
+    }))
+    .index("byCreatedBy", ["createdBy"]),
```

The `.relations()` line is the injected fixture that makes the lint fire; the
`.index("byCreatedBy", ...)` line is the fixer's own mechanical output,
appended by `appendIndexFix` from the finding's `metadata.suggestedIndex`.

Run sequence (real output; the temp path varies per run):

```
=== Plan 131 fixer PoC: unindexed_foreign_key on a temp copy of apps/playground ===
Fixture: temp copy at /tmp/plan-131-fixer-poc-XXXXXX, .relations() injected on channels.
Before: 2 advisories, target finding present: true
  cacheKey: unindexed_foreign_key:channels:createdBy
  metadata.suggestedIndex: {"fields":["createdBy"],"name":"byCreatedBy"}
Wrote fix to /tmp/plan-131-fixer-poc-XXXXXX/lunora/schema.ts
After: 1 advisories, target finding present: false
Idempotence: second apply changed=false (expected false)
PASS — finding is gone and the fix is idempotent.
```

Independently verified: `git status` stays clean across a run (the temp root is
removed in a `finally`); the fixer's output is Prettier-formatted through the
project's own resolved config; `pnpm --filter "@lunora/advisor" run test`
stayed green (49 files / 325 tests) throughout.

### 4.2 Suppression/baseline proof — `plan-131-baseline-poc.ts`

Target: `queue_without_dlq:notifications` — a real finding on the genuine
playground schema (not a synthetic one), acknowledged via
`packages/codegen/src/__prototype__/plan-131-baseline.demo.json` (§3.5's exact
fixture). Run output (real, not simulated):

```
=== Plan 131 baseline/suppression PoC: queue_without_dlq on apps/playground ===

Without baseline: 1 advisories:
  - queue_without_dlq:notifications

With baseline (1 entries):
  kept: 0 advisories:
  suppressed: 1 finding(s):
    - queue_without_dlq:notifications
        acknowledgedBy: d.bannert@anolilab.de
        acknowledgedAt: 2026-07-04T00:00:00.000Z
        reason: Fire-and-forget notifications queue — message loss on exhausted
          retries is acceptable per the queue's own doc comment in
          lunora/queues.ts. Acknowledged rather than fixed.

PASS — baseline-acknowledged finding is excluded from the output.
```

`applyBaseline` (the pure filter, §3.3) is order-preserving and non-destructive —
`suppressed` retains the full `Finding` alongside the `BaselineEntry` that matched
it, which is exactly the shape a `lunora advisor baseline list` reporting command
would need to show "these N findings are suppressed, here's why and by whom."

## 5. Open questions

### 5.1 Index-naming convention divergence (blocking §1.1's real ship, not this spike)

`suggestIndexName` (`packages/advisor/src/lints/static/fk-index.ts:15`) produces
camelCase: `` `by${field.charAt(0).toUpperCase()}${field.slice(1)}` `` →
`byCreatedBy`. Empirically verified this session (grep across `apps/`,
`packages/*/docs`, and codegen fixtures) that the actual house convention in
hand-written schemas is `by_<snake_case>`, frequently with a semantic suffix
strip rather than a literal field-name echo — `by_channel`, `by_author`,
`by_created`, `by_received`, not `by_channelId`/`by_createdBy`. A blind
AUTOFIX-SAFE fixer for `unindexed_foreign_key`/`unindexed_relation_target` would
therefore write a name that is mechanically correct but stylistically foreign to
every hand-written index in the same file — worse, permanently, since renaming an
index later is a breaking change to anything depending on stable index names.

Three resolution options, in increasing implementation cost:

1. **Ship `suggestIndexName` as-is.** Cheapest; produces a visibly inconsistent
   name next to hand-written indexes. Rejected — this is exactly the kind of
   small, permanent, low-value papercut a design spike exists to catch before
   ship, not after.
2. **Deterministic snake-case, no suffix-stripping**: `by_created_by`. Matches the
   `by_<snake>` half of the convention exactly; diverges only in not stripping the
   `_by`/`_id` suffix the way some hand-written examples do (`by_created` vs
   `by_created_by`). Fully mechanical (no semantic guessing required) — a pure
   string transform of the field name.
3. **Suffix-stripping heuristic** matching observed hand-written style most
   closely (`by_created_by` → `by_created`, `by_channel_id` → `by_channel`).
   Requires a stripping rule list (`_id`, `_by`, …) that will inevitably miss
   some field name, and any heuristic mismatch reintroduces exactly the
   inconsistency option 1 has, just less often.

**Recommendation: option 2.** It is fully deterministic (no heuristic to get
wrong), closes the vast majority of the observed gap (the `by_<snake>` casing,
which is the more jarring part of the mismatch), and a suffix-stripping pass (were
it ever wanted) is a strictly additive follow-up over a deterministic base — not
a rewrite. Shipping option 3 first risks a heuristic that's wrong often enough to
erode trust in the fixer's very small, very carefully-scoped safe list. This
document treats §1.1's real (non-spike) implementation as blocked on this
decision being made, not on further design work.

### 5.2 STOP-condition assessment: does the plan's "<5 AUTOFIX-SAFE → baseline-only" trigger fire?

The plan's own STOP condition: "fewer than ~5 lints AUTOFIX-SAFE → recommend
baseline-only and say so (valid completion)." §1.1 found exactly 4 (3 hard + 1
soft) — at the threshold, arguably under it depending on whether "soft" counts.
This does **not** invalidate building both prototypes (Step 4 is unconditional
regardless of the Step 1 count), and it does change the phased-rollout
recommendation (§6): **baseline/suppression is the higher-leverage, ship-first
capability** (covers all 83 lints, unblocks brownfield adoption of the entire
lint set immediately), not the AUTOFIX-SAFE fixer (covers 4 lints total, one
family). The fixer is still worth building — it is small, provably safe (§4.1),
and removes real manual toil for the FK-index family specifically — but it is not
"the" feature this plan enables; the baseline is.

### 5.3 `RunAdvisorOptions.baseline` vs. external wrapper (deferred, not decided)

§3.3 leans toward an external wrapper over threading a `baseline` option through
`runAdvisor` itself, but this is a judgment call, not a settled architectural
fact — a real implementation should revisit it once there are two or three real
call sites (CLI, studio, CI check) to see whether the "must remember to call it"
risk of the external-wrapper shape actually manifests.

### 5.4 Inline-directive suppression — worth building later?

§3.2 deferred inline (`// lunora-advisor-ignore`) suppression, citing the missing
source-span plumbing between codegen's IR and `Finding`. If that plumbing is ever
added for an unrelated reason (e.g. a studio "jump to source" feature for
findings), inline suppression becomes much cheaper and should be re-evaluated —
it is more ergonomic for a single-developer "I'll fix this next week" case than
editing a JSON file, even though the baseline file remains superior for
team-audit-trail purposes.

## 6. Phased rollout recommendation

1. **Baseline/suppression first.** Highest leverage (all 83 lints, not just the
   AUTOFIX-SAFE 4), lowest risk (pure filter, no schema mutation), and the
   prototype (§4.2) is already a complete proof of the hard part (cacheKey
   stability, audit trail, correct filter point relative to `LUNORA_ADVISORIES`
   baking). Ship as `lunora advisor baseline` (`ack`/`list`/`clear` subcommands
   over `lunora/advisor-baseline.json`) plus the codegen-time `applyBaseline` call.
2. **Interactive-confirm ASSISTED fixer second.** The larger surface (19 lints),
   and the studio `ApplyIndexButton` confirm-before-apply pattern is already a
   working UX precedent to extend to a general "Suggest fix" affordance per
   finding.
3. **Blind `--fix` for the AUTOFIX-SAFE 4 as a narrow micro-feature, last, and
   gated on §5.1.** Smallest lint count, smallest user-visible surface, but also
   the one where a wrong ship decision (the naming convention) is hardest to walk
   back — deliberately sequenced after the other two so it isn't the thing that
   determines whether this plan looks like it shipped something.

## 7. Verification performed this spike

- `pnpm --filter "@lunora/advisor" run test` — 49 files / 325 tests, green.
- `pnpm --filter "@lunora/codegen" run test` — 73 files / 748 tests, green.
- `pnpm --filter "@lunora/advisor" run lint:types` — clean.
- `pnpm --filter "@lunora/codegen" run lint:types` — clean (after fixing a
  `tablesObject possibly undefined` narrowing gap the prototype's own type-check
  caught — see `packages/codegen/src/__prototype__/plan-131-fixer-poc.ts`).
- `eslint` clean on both prototype files (package's own flat config plus one
  narrowly-scoped `__prototype__/**` override for `import/no-extraneous-dependencies`,
  since the PoC imports the `prettier` devDependency directly in source).
- `prettier --check` clean on both `.ts` files and the `.json` fixture,
  independently of the scripts' own formatting step.
- Both prototypes re-run end-to-end after every fix, confirming continued
  correctness (not just "compiles").
