# Plan 202 — Studio AI layer (Workers AI via the app's own binding)

- **Category**: feat (competitive parity — Prisma Studio AI affordances)
- **Priority**: P3
- **Effort**: L · **Risk**: MED
- **Status**: PHASE 0 DONE (decisions recorded); Phases 1–4 ready to build
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: AI assistance in Studio — natural-language → SQL (with
  database-error correction), natural-language → table filter, and chart-config
  inference from a result set — served by the app's own Workers AI binding, with
  every affordance hidden when that binding is absent.

## Phase 0 — decisions (RESOLVED 2026-07-28)

**Q1 — whose model?** `@lunora/ai`, i.e. Workers AI through the app's own `AI`
binding. Decided by the maintainer.

**Q2 — data egress?** Q1 largely dissolves it. Workers AI runs inference on the
user's OWN Cloudflare account, inside the same trust boundary the app already
runs in — the schema and result rows do not leave their infrastructure for a
third-party provider. So schema goes by default; **result row VALUES still stay
opt-in** for chart inference, because "same account" is not the same as "the
operator expected this row to be read by a model", and the opt-in costs one click.

**The repo already has this exact pattern**, which supersedes the "Studio ships
no provider / host supplies an `llm` prop" design sketched below.
`packages/do/src/issue-explainer.ts` backs the `__lunora_admin__:explainIssue`
RPC and establishes every convention this plan needs:

- The engine lives OUTSIDE `shard-do.ts` as a pure parse → ground → call → shape
  unit over an **injected binding**; `ShardDO` is a thin adapter supplying
  `env.AI` and writing the audit entry.
- It takes the raw `AI` binding, so `@lunora/do` needs **no dependency edge** on
  `@lunora/ai`.
- A pinned default model (`DEFAULT_EXPLAIN_ISSUE_MODEL`,
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), with a note that a retired model
  id makes `binding.run` throw and silently degrade every call.
- Input caps, a fencing delimiter around caller-supplied text, and a timeout —
  the DO's admin dispatch is single-threaded, so a hung model would block it.
- **Degrades to the non-AI answer** with no binding, a model error, or a timeout.
  The AI layer is additive, never the only help.

**Revised design.** Do NOT add an `llm` prop to `StudioProps`. Add a
`sql-assistant.ts` engine beside `issue-explainer.ts` and an
`__lunora_admin__:aiGenerateSql` RPC, mirroring it point for point. The Studio
calls that RPC like any other admin read and hides the affordance when it
reports no `AI` binding — the same capability-gating the SQL linter already uses.
That keeps the browser bundle free of provider code, needs no new credential
path, and inherits an audited, timeout-guarded, gracefully-degrading precedent
instead of inventing a second one.

**Still non-negotiable** (unchanged from below): generated SQL goes through the
same `shared/sql-readonly.ts` gate as hand-typed SQL and is shown to the operator
before it runs. Never auto-executed.

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

## Design — SUPERSEDED by Phase 0

The original sketch had `StudioProps` gain an `llm?: (request) => Promise<...>`
prop, with the host owning the model. Phase 0 replaces it: the repo already
solves this server-side (`issue-explainer.ts`), and routing through an admin RPC
keeps provider code out of the browser bundle entirely. The security rule
survives unchanged — generated SQL passes `shared/sql-readonly.ts` and is shown
before it runs.

## Phase 1 — NL → SQL

- [ ] `packages/do/src/sql-assistant.ts`, modelled on `issue-explainer.ts`: pure
      over an injected `AI` binding, input caps, a fencing delimiter around the
      operator's prompt, a timeout, and a pinned default model.
- [ ] Ground the prompt in the shard's real schema (`listTables` +
      `describeTables`), so the model names tables that exist.
- [ ] Validate before returning: the response must be ONE statement that passes
      `classifyStatement`. One bounded retry, then give up — never return
      unvalidated SQL.
- [ ] `__lunora_admin__:aiGenerateSql`, registered in the
      `schema-history-reads.ts` lookup (it is a read), with `ShardDO` supplying
      `env.AI` and writing the audit entry, exactly as `handleExplainIssue` does.
- [ ] Studio: a prompt input above the editor; the result lands in the editor
      **unexecuted**. The affordance is hidden when the RPC reports no binding —
      same capability gating the linter uses.

## Phase 2 — Database-error correction

- [ ] On a failed run, offer "fix this": statement + error fed back for a repair.
      Bounded to 2 attempts, each shown before running. This is what makes
      Phase 1 pay off — the first draft is often one column name away.

## Phase 3 — NL → table filter

- [ ] A prompt affordance on the data browser filter bar producing a STRUCTURED
      `FilterClause[]` (not raw SQL) against the table's `ColumnMeta`, so the
      existing filter validation applies unchanged.

## Phase 4 — Chart config from a result set

- [ ] Infer chart type + axis mapping for the editor's existing `chart` tab.
- [ ] Honour the Phase 0 egress line: column names + inferred types + row COUNT
      by default; row values only behind an explicit per-invocation opt-in.
- [ ] Validate the returned config against the actual columns — a hallucinated
      column must degrade to "could not infer a chart", never a broken render.

## Exit criteria

- With no `AI` binding, the entire Studio UI is byte-identical to before this
  plan — no disabled buttons, no upsell.
- With a binding, "show me the 10 most recent orders over $100" produces runnable
  SQL in the editor that the operator must click Run on.
- A statement the model generates that violates the read-only gate is refused by
  Studio before it reaches the RPC — asserted by a test with a stubbed `llm`.
- Every LLM-facing prompt builder is pure and unit-tested with a stub; no test
  requires a real model.
- The egress policy is stated in the Studio docs page, not only in code.

## STOP conditions

- **If chart inference cannot be made useful without row values**, stop and
  report rather than quietly widening the default egress.
- **If grounding the prompt needs more schema than `describeTables` returns**,
  stop before adding a new introspection RPC purely to feed a model.

## Non-goals

- Studio shipping or bundling a model, or holding provider credentials — the
  browser bundle never sees a model or a key.
- An agentic loop inside Studio (multi-step tool use, autonomous mutation).
  `@lunora/agent` + `@lunora/mcp` own that; this is single-shot assistance.
- AI-generated _writes_. Every task here produces a read, a filter, or a chart.
- Query-insight recommendations — those depend on plan 203's time-series data;
  file as a follow-on once both have landed.
