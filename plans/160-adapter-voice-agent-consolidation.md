# Plan 160: Consolidate the ~2k-line voice/agent surface duplicated across all 5 framework adapters

> **Executor instructions**: This is a refactor plan. Follow step by step; run each
> Verify. Honor STOP conditions. Update `plans/README.md` when done. Land it incrementally
> (voice-audio first — it's the trivial, byte-identical extraction).
>
> **Drift check (run first)**: `git diff --stat f41f1823..HEAD -- packages/react/src packages/vue/src packages/solid/src packages/svelte/src packages/angular/src packages/client/src`
> On any change, compare "Current state" to live code; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: M (voice-audio + pagination) / L (agent cores)
- **Risk**: LOW (voice-audio) / MED (agent/voice cores)
- **Depends on**: interacts with plans 149 (optimistic echo) and 150 (pagination guard) — see notes
- **Category**: tech-debt
- **Planned at**: commit `f41f1823`, 2026-07-18

## Why this matters

`voice-audio.ts` (~326 lines, **zero imports**, framework-free Web Audio) is copied
verbatim (comment-only differences) into all five framework adapters. The agent surfaces
(`use-agent-chat`/`agent-chat`, `use-voice-agent`/`voice-agent`, `agent-tool-events`,
`agent-state`) are near-verbatim ports (~1,400 lines/adapter), and four adapters hand-roll a
pagination engine over the shared `@lunora/client/pagination` helpers. The cost is already
paid in shipped drift: the optimistic-echo bug (plan 149) ships in all 5 copies, and the
pagination reentrancy guard (plan 150) exists in only 1 of 4. ~2k lines of pure logic × 5 to
keep in sync — exactly the drift class `@lunora/client/pagination` and `@lunora/client/query`
were built to prevent.

## Current state

- `packages/{react,vue,solid,svelte,angular}/src/voice-audio.ts` — diff shows comment-only
  differences; zero imports (framework-free Web Audio).
- `use-agent-chat`/`agent-chat` (`reconcileOptimistic` copied 5×: react:193, vue:184,
  solid:184, svelte:194, angular:136), `use-voice-agent`/`voice-agent` (~470–507 lines each;
  `globalThis.WebSocket` construction copied 5×), `agent-tool-events`, `agent-state`.
- Four hand-rolled pagination engines (vue/solid/svelte/angular) over
  `@lunora/client/pagination`; Angular's has the reentrancy guard, the others don't (plan 150).
- Precedent: `@lunora/client/pagination` and `@lunora/client/query` already ship
  framework-agnostic cores that adapters bind to reactively.

Conventions: ESM, no `.js` extensions; named exports only; `@lunora/client` is the shared
core the adapters depend on.

## Commands you will need

| Purpose    | Command                                                                                                                                                                       | Expected |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Build deps | `pnpm run build:packages`                                                                                                                                                     | exit 0   |
| Typecheck  | `pnpm --filter "@lunora/client" --filter "@lunora/react" --filter "@lunora/vue" --filter "@lunora/solid" --filter "@lunora/svelte" --filter "@lunora/angular" run lint:types` | exit 0   |
| Tests      | each adapter's `run test`                                                                                                                                                     | all pass |

## Scope

**In scope**: `packages/client/src` (new shared cores/subpath exports) + the five adapters'
voice/agent/pagination files + tests. **Out of scope**: changing the public hook APIs the
adapters expose (they stay; only their internals move to shared cores).

## Git workflow

- Branch: `advisor/160-adapter-consolidation`; commit per extraction, e.g.
  `refactor(client): ship shared voice-audio; adapters re-export`.

## Steps

### Step 1 (S, do first): move `voice-audio.ts` into `@lunora/client`

It's framework-free with zero imports — move it wholesale to `@lunora/client` (a
`@lunora/client/voice-audio` subpath or internal module), and have all five adapters import
it instead of holding a copy. Byte-identical behavior. **Verify**: all five adapters typecheck

- their voice tests pass; `git` shows five deletions + one addition.

### Step 2 (M): shared pagination sync engine

Extract a single pagination sync engine (WITH the Angular reentrancy guard from plan 150) into
`@lunora/client/pagination`, and make vue/solid/svelte/angular bind to it reactively instead of
hand-rolling. Preserves each adapter's reactive wrapper. **Verify**: pagination tests pass in
all four; the reentrancy guard now protects all of them (folds in plan 150).

### Step 3 (L): framework-agnostic agent-chat + voice-agent cores

Extract `createAgentChatCore` and `createVoiceAgentCore` (callbacks-in, state-events-out — the
pattern `createQuerySubscription` uses) into `@lunora/client`, carrying the FIXED
`reconcileOptimistic` (plan 149) and the credentialed-socket default (RN-01, plan 158). Adapters
become thin reactive bindings. **Verify**: agent-chat/voice tests pass in all five; the
repeated-prompt echo bug is fixed once, in the core.

### Step 4: delete the duplicates + tests

Remove the per-adapter copies superseded by the cores; keep/adjust adapter tests to exercise the
thin bindings. **Verify**: each adapter's test suite passes; `grep` shows the duplicated logic is
gone.

## Done criteria

- [ ] `lint:types` passes for client + all five adapters
- [ ] All five adapter test suites pass
- [ ] `voice-audio.ts` exists once (in `@lunora/client`); the five copies are deleted
- [ ] Pagination sync (with the reentrancy guard) and the agent-chat/voice cores are shared, not per-adapter
- [ ] No public adapter hook API changed (same exports)
- [ ] No out-of-scope files modified; `plans/README.md` row updated

## STOP conditions

- An adapter's copy has a genuine framework-specific divergence that can't live in a shared core
  (not just comments) — report which; extract only the truly shared parts.
- Plans 149/150/158 have NOT landed and their fixes would be lost in the extraction — coordinate:
  carry the fixed versions into the cores (don't re-introduce the bugs). If unsure of the tree
  state, run the drift check and report.

## Maintenance notes

- After this, a bug in optimistic reconcile / pagination / voice is fixed once. This plan is the
  structural fix for the whole "one bug × five copies" class; 149/150/158 are the point-fixes it
  subsumes if it lands after them.
- A reviewer should confirm each adapter's reactive wrapper is genuinely thin (no re-implemented logic).
