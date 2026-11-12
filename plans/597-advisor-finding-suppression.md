# Plan 597 — Per-finding advisor suppression: one rule, one site, a required reason, always visible

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: the branch is stacked on plan 596's branch. `git log --oneline -1`
> equals the 596 tip the reviewer names in the brief. `git diff --stat <596 tip>..HEAD` → empty.

**Baseline:** plan 596's branch tip (stacked on 595 `a75902bbb`, 2026-11-12)
**Status:** TODO
**Source:** follow-up to row 50 of the 2026-11-11 audit; third PR of the stack (595 → 596 → 597 → 588).

## Status

- **Priority**: P1 (unblocks row 50) · **Effort**: L · **Risk**: MED (touches the deploy gate) · **Depends on**: plans 595, 596 · **Category**: feature

## 0. Headline

An app has no way to say "this one finding at this one site is accepted, for this reason". The only
directive, `// lunora-advisor-exempt -- reason` above an export, removes a whole procedure from the
`lunora advisor` health-map score and does not touch codegen findings or the ERROR gate. The advisors
docs page also describes a Studio dismissal by `cacheKey` that no code implements. This plan adds a
rule-scoped, site-scoped inline suppression that every surface honours and shows.

## 1. Current state (audit)

- Existing directive: `packages/codegen/src/discover/procedure-middleware.ts:660-724` —
  `EXEMPT_DIRECTIVE = "lunora-advisor-exempt"`, `exemptionOf(declaration)` reads it from the declaration's
  leading comments (word-boundary checked) and returns `{ exempt, exemptReason }`; consumed only by
  `packages/advisor/src/map/score-advisor.ts:146-155` (health map).
- Where codegen produces the advisory list: `packages/codegen/src/run-codegen.ts` ~604-630,
  `const advisories = … applyAdvisorPolicy(options.projectRoot, [...runAdvisor(advisorContext, { source: "static" }), …])`
  (`applyAdvisorPolicy` in `packages/codegen/src/advisor-floor.ts:75`). That list feeds the result, the
  terminal, `LUNORA_ADVISORIES` in `_generated/shard.ts` (Studio and the MCP tool read it), `lunora advisor`
  (`packages/cli/src/commands/advisor/handler.ts:158-165` calls `runCodegen` and `scoreAdvisor`), and the gate.
- Gate: `packages/cli/src/util/advisory-gate.ts:53` (`advisories.filter((a) => a.level === "ERROR")`) and
  `packages/codegen/src/blocking.ts:22` (`errorAdvisoryNames`). Used by `lunora codegen` and `lunora deploy`.
- Terminal rendering: `packages/cli/src/commands/codegen/handler.ts:121-128` (`[LEVEL] name — detail`), and the
  JSON result mapping at `:103-108`.
- Studio: `packages/studio/src/features/advisors/advisor-view.tsx:73` `advisoryRow(finding)`, used by
  `insights-panel.tsx:455` and the security/health panels in the same folder.
- MCP: `packages/mcp/src/observability-tools.ts` tool `lunora_get_advisories` (~165-300).
- `Finding` type: `packages/advisor/src/types.ts:105-126`. After plans 595/596 every static finding with a
  source site carries `metadata.file` (relative to `lunora/`, no extension — except `shapes` rows, which carry
  `lunora/shapes.ts`, and wrangler findings, which carry `wrangler.jsonc` relative to the project root) and
  `metadata.line` (1-based). Plan 596's report lists the rules that stay without a location.
- Docs: `packages/advisor/docs/index.mdx` (the reference; `__tests__/docs-lint-reference.test.ts` requires every
  lint-table row to name a registered lint), `apps/docs/src/content/docs/concepts/advisors.mdx:129-130`
  (the unimplemented Studio dismissal sentence).

## 2. Design decisions (with rejected alternatives)

1. **Syntax** — extend the existing family:
   `// lunora-advisor-exempt <rule_id> -- <reason>` on its own line, directly above the code it excuses.
   `<rule_id>` is a snake_case lint name (`[a-z][a-z0-9_]*`). A directive with no rule id keeps today's
   whole-procedure health-map meaning, unchanged, and is not a suppression. In `wrangler.jsonc` the same
   `//` comment form is accepted (JSONC allows comments) for findings whose `metadata.file` is `wrangler.jsonc`.
   Rejected: a new directive name (two families for one concept); a config list or baseline file (the owner
   ruled out non-inline mechanisms); a block comment form (one form is enough).
2. **Attachment and matching** — a directive on line `L` of file `F` attaches to the code that begins on the
   next line containing code, `L' > L` (skipping blank lines and other comments). In a `.ts` file the attached
   node is found from the first token on `L'`: take the smallest node containing that token's position, then
   climb parents while the parent's start position equals that token's start position; the top of that climb is
   the attached node, and its span is `[L', endLine(node)]`. (So a statement — including a multi-line call whose
   finding reports an argument's line — is covered whole, while a chained `.index(...)` line or a property line
   covers only itself.) In `wrangler.jsonc` the span is `[L', L']`. A finding is suppressed by the directive iff
   `finding.name === rule_id` AND normalised `metadata.file` equals normalised `F` AND
   `L' <= metadata.line <= spanEnd`. Normalisation: strip a leading `lunora/` and a `.ts`/`.tsx`/`.js`/`.mts`
   extension for `lunora/` files; `wrangler.jsonc` compares as-is. Never by rule alone, by file alone, or by procedure.
   Rejected: matching only the exact line (misses multi-line statements); the enclosing function (too wide).
3. **Required reason** — the text after `--`, trimmed, must be non-empty. A directive with a rule id but no reason
   suppresses nothing and is reported as WARN finding `advisor_suppression_invalid` (metadata: file, line, rule).
   Same WARN for an unknown rule id, and for a rule listed by plan 596 as having no location (with a detail that says
   so). A runtime lint id gets the same WARN (runtime lints are out of scope: they have no source site).
4. **Unused** — a valid directive that suppresses no finding is reported as WARN `advisor_suppression_unused`
   (metadata: file, line, rule) so stale directives get removed.
5. **Visible, not dropped** — a suppressed finding stays in the advisory list with
   `suppressed: { reason: string; file: string; line: number }` (the directive's site) added to `Finding`
   (optional field). Every surface shows it as suppressed with the reason, and counts them.
6. **Gate** — `advisory-gate.ts` and `errorAdvisoryNames` ignore findings with `suppressed` set. An unsuppressed ERROR
   still blocks even when a suppressed one sits next to it. No global switch; no level changes.
7. **One application point** — `applySuppressions(projectRoot, lunoraDirectory, advisories)` in a new
   `packages/codegen/src/advisor-suppressions.ts`, called in `run-codegen.ts` right after `applyAdvisorPolicy`, so the
   result, terminal, `_generated`, `lunora advisor`, deploy, Studio and MCP all see the same marked list.
   Directive scanning reads the `lunora/` source files already loaded in the ts-morph project, plus `wrangler.jsonc`
   at the project root if present. The two meta findings are built with the advisor's `emit` shape (categories `["SCHEMA"]`,
   facing `INTERNAL`, level `WARN`, cacheKey `<name>:<file>:<line>`), and are NOT registered as lints (so no docs table row).
8. **Health map** — `scoreAdvisor` treats a suppressed finding as not failing/warning for its procedure, and the summary gains a
   `suppressed` count; `lunora advisor` prints suppressed findings with their reason.
9. **Existing directive parser** — `exemptionOf` must ignore a directive that carries a rule id (it is a suppression, not a
   procedure exemption). Test both.

## 3. Steps (one commit each)

1. **Advisor type** — `Finding.suppressed?` (types.ts, JSDoc). Export nothing else new from `@lunora/advisor` unless needed by the CLI/Studio/MCP; if you export, the reviewer runs `api:update`.
2. **Codegen** — `advisor-suppressions.ts` (directive parser, attachment per §2.2, matcher, the two meta findings), wired in `run-codegen.ts`; `exemptionOf` ignores rule-id directives; `errorAdvisoryNames` skips suppressed. Tests in `packages/codegen/__tests__/advisor-suppressions.test.ts` (model the fixture setup on an existing codegen test that writes a temp `lunora/` dir), covering: suppresses rule A at a single-line site; multi-line statement where the finding's line is an argument line; does NOT suppress rule B on the same line; does NOT suppress rule A one statement below; no reason → not suppressed + `advisor_suppression_invalid`; unknown rule → invalid; unused → `advisor_suppression_unused`; a no-rule directive still exempts the procedure in the health map and suppresses nothing; a `wrangler.jsonc` directive above a variable key suppresses `plaintext_secret_in_wrangler_variables` for that key only; path normalisation for a `shapes` finding.
3. **Gate** — `advisory-gate.ts` ignores suppressed; test in `packages/cli/__tests__/` next to the existing advisory-gate test (find with `grep -rl evaluateAdvisoryGate packages/cli/__tests__`): one suppressed ERROR + one unsuppressed ERROR → `shouldBlock` true with only the unsuppressed name; one suppressed ERROR alone → `shouldBlock` false, and the suppressed finding is still returned/visible.
4. **CLI rendering** — codegen terminal: suppressed findings print as `[LEVEL] name (suppressed: <reason>) — detail` after a count line `N suppressed`; JSON result includes `suppressed`. `lunora advisor` report shows a suppressed count and the list. Deploy prints the same as codegen (find where deploy prints advisories). Tests next to existing handler/report tests.
5. **Studio** — `advisoryRow` carries `suppressed`; the views show a "Suppressed" badge with the reason (tooltip or inline) and a count in the panel header; use existing badge/i18n patterns in `packages/studio/src/features/advisors/*` and add strings to `packages/studio/src/locales/en.ts` (and any locale files the repo requires keys in). Test next to existing advisor-view tests.
6. **MCP** — `lunora_get_advisories` includes `suppressed` (reason, file, line) per advisory and documents it in the tool's output schema description. Test next to existing MCP tool tests.
7. **Docs** — `packages/advisor/docs/index.mdx`: a "Suppressing one finding" section (syntax, attachment rule, matching, required reason, the two WARN findings, gate behaviour, visibility, runtime lints out of scope, the list of rules without a location from plan 596). `apps/docs/src/content/docs/concepts/advisors.mdx`: replace the Studio-dismissal sentence (`:129-130`) with what exists now (the inline directive; the cacheKey is a stable id for dedup), and link to the reference. Run prettier on both.
8. **Red without the fix** — with all commits in place, restore `run-codegen.ts`, `advisory-gate.ts`, `blocking.ts` from the 596 tip (`git show <596 tip>:<p> > <p>`) and confirm the suppression and gate tests FAIL; restore; pass.

## Commands

| Purpose                      | Command (worktree root)                     | Expected |
| ---------------------------- | ------------------------------------------- | -------- |
| Tests                        | `pnpm --filter "@lunora/<codegen            | advisor  | cli | studio | mcp>" run test` | pass |
| Lint / types                 | same packages, `lint:eslint` / `lint:types` | exit 0   |
| Rebuild a changed dependency | `pnpm --filter "@lunora/<pkg>" run build`   | exit 0   |

## Scope

In: the files named in §1/§3, new `advisor-suppressions.ts` and its test, locale strings, the two docs pages. Out: any rule's level, wording, cacheKey or matcher; runtime lints; `advisor.minSeverity`; every app (the reviewer runs the sweep and the 588 PR adds the first in-repo directive).

## STOP conditions

- A finding family the reviewer's 596 report says has a location does not carry `metadata.file`/`metadata.line` at runtime.
- A surface (CLI/Studio/MCP) renders findings in a way this plan does not cover (report where).
- Any change would alter a rule's severity or matcher.
- A verification fails twice.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## Maintenance notes

- A new lint must report `metadata.file`/`metadata.line` to be suppressible; otherwise a directive for it is reported as invalid.
