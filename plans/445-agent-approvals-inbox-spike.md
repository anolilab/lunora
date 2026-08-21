# Plan 445: [Spike] Design a pending-approvals listing for the HITL surface

> **Executor instructions**: This is a DESIGN SPIKE — the deliverable is a
> design document, not implementation. Do not modify any `src/` file. Follow
> the steps, honor STOP conditions, and write the deliverable exactly where
> Step 4 says. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/agent/src/component.ts packages/agent/src/model-messages.ts packages/mcp/src/agent-tools.ts`
> On drift, re-verify the "Current state" facts before designing against them.

## Status

- **Priority**: P2
- **Effort**: M (design only)
- **Risk**: MED (the design touches owner-gating; a wrong collection-level gate is a cross-tenant leak)
- **Depends on**: plans/436-agent-hitl-approval-reclaim.md (its timeout/terminal-marker semantics feed this design)
- **Category**: direction
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The HITL surface has a resolve verb with no matching list verb. `agentResolveApproval` requires the caller to already know `{ threadKey, instanceId, toolCallId }`, and nothing in the component produces that triple — a client can only discover a pending approval by subscribing to the exact thread it created. There is no "approvals inbox" across an owner's threads, no way for an operator or a second agent to find work blocked on a human, and over MCP a gated tool call is a dead end (the MCP agent surface has a status poll but no approvals tool). The data is already persisted: `awaiting_approval` message rows exist precisely as UI markers (they're filtered out of the model prompt for that reason), and the threads table has an `awaiting_input` status. Combined with the pre-436 reclaim bug, the absence of a list surface is what made stranded approvals invisible.

## Current state (verified facts to design against)

- `packages/agent/src/component.ts:934-951` — exported functions: `agentMessages`, `agentResolveApproval`, `agentRun`, `agentState`, `agentThread` (public) + internals (`agentAppendMessage`, `agentCompleteRun`, `agentEnsureThread`, `agentPatchThread`, `agentSetState`) + graph/episodic. No listing across threads.
- `packages/agent/src/component.ts:775-784` — `agentResolveApproval`'s gates: `readableThread` owner gate (unknown/forbidden indistinguishable), then instance-ownership check.
- `packages/agent/src/agent-loop.ts:216-223` — the `awaiting_approval` marker row: `messageKey: ${instanceId}:approval:${call.id}`, `role: "tool"`, `status: "awaiting_approval"`, `toolCallId`, `toolName`.
- `packages/agent/src/model-messages.ts:68-74` — `awaiting_approval` rows are skipped when building the model prompt ("a UI/observability marker, not a real tool result").
- Threads table carries `status` (including `awaiting_input`) and an instance id; check its indexes in `component.ts` (the audit cited a `byInstance` index near the table definition, ~`:497`) — enumerate the actual indexes as part of Step 1.
- `packages/mcp/src/agent-tools.ts:30-42` — MCP advertises `lunora_agent_status` (poll over `agents:agentThread`); no approvals enumeration/resolution tool.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Read-only test run (context) | `pnpm --filter "@lunora/agent" run test` | all pass (baseline) |

## Scope

**In scope** (files you may create):
- `plans/445-agent-approvals-inbox-design.md` (the deliverable)

**Out of scope**:
- Any `src/` modification, any schema change, any MCP tool implementation.

## Git workflow

- Branch: shared wave branch `improve/wave22-agent`.
- Commit: `docs(agent): design the pending-approvals inbox`

## Steps

### Step 1: Inventory the read path

Read `component.ts`'s thread + message table definitions and indexes in full. Answer in the doc: can "all of an owner's threads with `status = 'awaiting_input'`" be served by an existing index, or does it need a new one? Ditto joining each such thread to its `awaiting_approval` message rows (what index does `agentMessages` use?). Record exact index names/columns.

### Step 2: Design the query surface

Specify `agentPendingApprovals` (name negotiable): args, return shape (the resolve triple `{ threadKey, instanceId, toolCallId }` plus display fields `toolName`, `content`, `agent`, timestamps), pagination (cursor shape — follow whatever `agentMessages` does), and ordering. Decide and justify: is it owner-scoped only (`{ owner }` from verified identity, like `agentMessages`'s gate) or also operator-scoped (admin/all-owners — if so, which existing admin gate pattern applies)? The collection-level gate must reproduce `readableThread`'s semantics at scale — spell out how a paginated cross-thread query avoids leaking thread existence across owners.

### Step 3: Interactions and alternatives

- How 436's approval timeout changes the inbox: a timed-out (`rejected`-marker) approval must not appear as pending — state the filter.
- MCP: propose whether `lunora_agent_approvals` (list) and/or resolution get MCP tools, and under which config gate (the MCP agent surface is config-gated fail-closed — name the existing gate).
- Alternative considered: pushing approvals through `@lunora/notify` instead of (or in addition to) a pull query — one paragraph with the trade-off.

### Step 4: Write the deliverable

`plans/445-agent-approvals-inbox-design.md`: sections = Inventory (Step 1 facts), Proposed API (Step 2), Gating analysis, Interactions (Step 3), Open questions (each with a recommended answer), and a build-effort estimate per piece (query / client surface / MCP tool). Self-contained — a future build plan starts from this doc alone.

**Verify**: the doc exists; every open question has a recommended answer; no `src/` file modified (`git status`).

## Test plan

Not applicable (design spike). The doc's "Proposed API" section must include the test surface a build plan would need (which existing component tests to model on).

## Done criteria

- [ ] `plans/445-agent-approvals-inbox-design.md` exists with all five sections
- [ ] `git status` shows no `src/` modifications
- [ ] Step 1's index inventory cites exact `component.ts` line numbers at the executor's HEAD

## STOP conditions

- The thread/message schema lacks the columns the inbox needs (would require a schema migration) — record it as the doc's headline open question rather than designing around fictional columns.
- Plan 436 has not landed and its final marker semantics are undecidable from the branch state — write the design against both candidate semantics and flag it.

## Maintenance notes

- The reviewer should sanity-check the gating analysis with fresh eyes — it is the one part where a plausible-looking design can hide a cross-tenant leak.
