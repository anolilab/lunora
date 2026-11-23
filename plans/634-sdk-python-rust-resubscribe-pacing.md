# Plan 634: Python and Rust SDKs pace their re-subscribes after a reconnect like the reference client (re-audit, then fix)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- sdks/python sdks/rust packages/client/src/lunora-client.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE (Python, Rust), pushed: `fix/sdk-python-rust-resubscribe-pacing`. Go, Java, Ruby, Kotlin, Dart and Swift still re-subscribe in one burst (read only, not changed). Unlike the reference, a timed-out slot is freed but its frame is not sent again; PR #1644

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

After a reconnect the reference TypeScript client re-sends its subscriptions a few at a time rather than in one burst, so a client with many live queries does not hit the shard with all of them in the same tick (which trips per-connection backpressure or rate limits and causes another disconnect). An earlier audit read the Python and Rust SDKs as re-subscribing everything at once. **This must be re-verified**: `origin/alpha` has since changed the re-subscribe code in every SDK (retry-hint work, #1579–#1582), and the earlier line numbers no longer apply.

## Steps

1. Establish the reference behaviour: in `packages/client/src/lunora-client.ts` find how subscriptions are re-sent on reconnect (`rg -n -i "resubscrib|replaySubscriptions|pace|concurrency|inflight" packages/client/src/lunora-client.ts | head -40`). Record the constant, its value and the mechanism (window of N unacked subscribes; next sent on ack), with file:line. Check `sdks/README.md` and `protocol/` for a conformance statement about it.
2. For Python (`sdks/python/lunora/client.py`) and Rust (`sdks/rust/src/client.rs`): find the reconnect re-subscribe path and state, with file:line, whether it is paced. Then do the same quick read for the other six SDKs (go, ruby, kotlin, dart, java, swift) and list each as PACED / BURST / UNCLEAR — read only, no changes there.
3. If Python and Rust are both already paced: report NOT REPRODUCED, commit nothing.
4. Otherwise implement the reference mechanism in the burst SDK(s) among Python and Rust only, matching the reference constant, following each SDK's existing structure and test style. Add a test per SDK that registers more subscriptions than the window, simulates a reconnect, and asserts no more than the window is outstanding until acks arrive. Tests wait on a milestone, never a sleep.
5. Run each touched SDK's own suite and linter the way `sdks/run-all.sh` and `sdks/lint-all.sh` run them for that language only (read the scripts; do not run all eight). If a toolchain (python/uv, cargo) is missing on this machine, STOP for that SDK and say so.

## Scope

**In scope**: `sdks/python`, `sdks/rust` sources and tests. **Out of scope**: the six other SDKs (report only), the TypeScript client, the protocol.

## Git workflow

- Branch: `fix/sdk-python-rust-resubscribe-pacing`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(sdk): pace re-subscribes in the python and rust ports`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The reference client does not pace re-subscribes on alpha any more: report, commit nothing.
- A generated-file check applies (`sdks/generated-check.sh`): run it for the touched SDK; if it fails for reasons unrelated to your change, report and do not "fix" generated output by hand.
