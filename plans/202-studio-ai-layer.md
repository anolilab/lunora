# Plan 202 — Studio AI layer (pluggable `llm` hook)

- **Category**: feat (competitive parity — Prisma Studio AI affordances)
- **Priority**: P3
- **Effort**: L · **Risk**: MED
- **Status**: TODO (product decision first — see "Prerequisite")
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: one host-supplied `llm` hook that powers natural-language → SQL (with
  database-error correction), natural-language → table filter, and chart-config
  inference from a result set — with every affordance hidden when no host wires
  the hook.

## Prerequisite (do not skip)

This is the only plan in the wave that is **not** purely an engineering call.
Shipping AI in Studio means deciding whose model, whose key, and what data leaves
the machine. Get an explicit answer before Phase 1:

- Which host provides the model — the CLI dev host via `@lunora/ai`
  (`ctx.ai`, Workers AI on the Vercel AI SDK), `apps/cloud` via its own
  credentials, or BYO-key in Studio settings?
- Is sending schema (always) and result rows (for chart inference) to a model
  acceptable by default, or strictly opt-in?

Phase 0 exists to answer these on paper. **Do not write Phase 1 code first.**

## Context (verified)

**Studio has no LLM surface today.** `packages/studio/package.json` has no AI
dependency. What exists is adjacent, not overlapping:
`features/home/connect-agent.tsx` hands off to an external agent over MCP
(`@lunora/mcp`), and `features/agents/agents-panel.tsx` observes `@lunora/agent`
runs. Neither generates anything inside Studio.

**The platform pieces exist.** `@lunora/ai` puts Workers AI behind `ctx.ai` on
the Vercel AI SDK v7, and `@lunora/mcp` already fronts a deployment for agents.
So this plan is a Studio-side contract question, not a model-integration one.

**What Prisma does** (`Architecture/sql-ai-generation.md`,
`sql-result-visualization.md`, `query-insights.md`, `views/table/table-ai-filter.ts`):
a single `llm` hook on the embedder contract takes a task-tagged request and
returns a typed response. Four tasks ride it — SQL generation (with a
validate-and-retry contract, and a **database-error correction** loop that feeds
a failing query and its error back for a fix), table filtering, chart config from
a result set, and query-insight recommendations. The hook is optional; absent it,
the AI affordances simply are not rendered.

## Design

**Studio ships no provider.** `StudioProps` gains
`llm?: (request: LlmRequest) => Promise<LlmResponse>` over a discriminated union
of tasks. Studio owns the prompts, the validation, and the UI; the host owns the
model, the credentials, and the network. This mirrors how `schemaEditable`
already gates the schema-authoring overlay to loopback dev hosts — capability in,
feature out.

**Fail-closed and invisible.** No `llm` prop ⇒ no AI buttons anywhere. Not
disabled buttons, not upsells.

**Generated SQL is never privileged.** Anything the model produces goes through
the same `sql-console.ts` read-only gate as hand-typed SQL, and is **shown to the
operator before it runs** — never auto-executed. The model is a drafting aid
inside the existing security boundary, not a way around it.

**Data egress is explicit.** Schema (table/column names) is sent for SQL and
filter tasks; **result rows** would be sent for chart inference — a different
category. Chart inference sends column names + inferred types + row _count_ by
default, with row values only behind an explicit per-invocation opt-in, and the
UI says plainly what is being sent.

## Phase 0 — Contract + decision record

- [ ] Write the `LlmRequest` / `LlmResponse` discriminated union (tasks:
      `sql-generate`, `sql-fix`, `table-filter`, `chart-config`) and the
      egress policy above into a short design note in this file.
- [ ] Get the two Prerequisite answers on record. **STOP here until then.**

## Phase 1 — NL → SQL

- [ ] `llm` prop threaded through `StudioProps` → context, with a
      `useLlm()` hook returning `undefined` when unwired.
- [ ] Prompt construction from the `SqlSchema` the editor already assembles
      (`features/sql/sql-autocomplete.ts`) — table names always, columns for
      probed tables.
- [ ] Validation before display: the response must be a single statement that
      passes `shared/sql-readonly.ts` (plan 201 Phase 1 extracts it; if 201 has
      not landed, import from `sql-console.ts`'s exported gate rather than
      duplicating the regex). One bounded retry on validation failure.
- [ ] UI: a prompt input above the editor; the generated SQL lands **in the
      editor, unexecuted**, with a diff-ish highlight of what changed.

## Phase 2 — Database-error correction

- [ ] On a failed run with a generated statement in the editor, offer "fix this"
      — feed statement + error message back as a `sql-fix` task. Bounded to 2
      attempts, each shown before running. This is the affordance that makes
      Phase 1 actually pay off.

## Phase 3 — NL → table filter

- [ ] A prompt affordance on the data browser filter bar
      (`features/data/data-filters.tsx`) producing a structured `FilterOperator`
      predicate (not raw SQL) against the browsed table's `ColumnMeta`.
      Structured output means the existing filter validation applies unchanged.

## Phase 4 — Chart config from a result set

- [ ] `sql-editor-panel.tsx` already has a `chart` result tab. Infer chart type +
      axis mapping from the result's column names/types, render with `recharts`
      (already a dependency).
- [ ] Honour the egress policy: columns + types + row count by default; values
      only on explicit opt-in.
- [ ] Validate the returned config against the actual columns before rendering —
      a hallucinated column name must degrade to "could not infer a chart", never
      to a broken render.

## Exit criteria

- With no `llm` wired (the default for `@lunora/studio` consumers today), the
  entire Studio UI is byte-identical to before this plan.
- With `llm` wired, "show me the 10 most recent orders over $100" produces
  runnable SQL in the editor that the operator must click Run on.
- A statement the model generates that violates the read-only gate is refused by
  Studio before it reaches the RPC — asserted by a test with a stubbed `llm`.
- Every LLM-facing prompt builder is pure and unit-tested with a stub; no test
  requires a real model.
- The egress policy is stated in the Studio docs page, not only in code.

## STOP conditions

- **If the Prerequisite answers are not available**, do not proceed past Phase 0.
  Guessing the credential model produces a surface that has to be redesigned.
- **If chart inference cannot be made useful without row values**, stop and
  report rather than quietly widening the default egress.

## Non-goals

- Studio shipping or bundling a model, or holding provider credentials.
- An agentic loop inside Studio (multi-step tool use, autonomous mutation).
  `@lunora/agent` + `@lunora/mcp` own that; this is single-shot assistance.
- AI-generated _writes_. Every task here produces a read, a filter, or a chart.
- Query-insight recommendations — those depend on plan 203's time-series data;
  file as a follow-on once both have landed.
