# Plan 637: Go, Java, Ruby, Kotlin, Dart and Swift SDKs pace re-subscribes after a reconnect

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- sdks/go sdks/java sdks/ruby sdks/kotlin sdks/dart sdks/swift`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: pattern from commit 7826eb105 (python, rust)
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

After a reconnect the reference TypeScript client keeps at most 3 unanswered `subscribe` frames per shard and sends the next when one is answered (`RESUBSCRIBE_CONCURRENCY = 3` at `packages/client/src/client-tuning.ts:74`, `RESUBSCRIBE_ACK_TIMEOUT_MS = 10_000` at `:85`; queue/drain in `packages/client/src/lunora-client.ts` around 7079-7131, slot freed by any server frame carrying the subscription id ~7315, re-queue on socket open ~6845, unsubscribe frees its slot ~3481). Commit `7826eb105` on branch `fix/sdk-python-rust-resubscribe-pacing` ported this to Python and Rust. The other six ports still send every subscription in one burst: Go `client.go` ~1402 (send loop ~1458-1489), Java `Client.java` ~1500 (~1551-1567), Ruby `client.rb` ~724 (~760-770), Kotlin `Client.kt` ~1102 (~1132), Dart `client.dart` ~813 (~850), Swift `Client.swift` ~1175 (~1218). Line numbers are hints.

## Design (decided)

Port the mechanism exactly as `7826eb105` did (read it first: `git show 7826eb105`): window of 3 query subscriptions; the rest queued; a frame is built when it is sent (so it carries the then-current cursor); any server frame with the subscription's id frees its slot and sends the next; unsubscribe frees a held slot; attach/detach/close clear the queue; a slot unanswered for 10 s is freed through the port's existing retry/timer hook; shape subscriptions are **not** paced. Follow each port's existing structure, naming and test style; add tests equivalent to the Python ones (`sdks/python/tests/test_resubscribe_pacing.py`), driven by an injected clock — no sleeps. Update each port's README where it documents the caller's socket loop.

## Steps

For each port, in this order — go, ruby, java, kotlin, dart, swift — and one commit per port:

1. Check the toolchain exists (`go version`, `ruby -v` + bundler, `java -version` + the build tool the port uses, `dart --version`, `swift --version`). Read `sdks/run-all.sh` and `sdks/lint-all.sh` to see exactly how that port is tested and linted. **If the toolchain is missing, skip the port and say so — do not write code you cannot run.**
2. Tests first; see them fail. 3. Implement. 4. Run that port's suite and linter only, and `sdks/generated-check.sh <port>`.

## Scope

**In scope**: `sdks/{go,java,ruby,kotlin,dart,swift}`. **Out of scope**: python, rust, the TypeScript client, `protocol/`.

## Git workflow

- Branch: `fix/sdk-resubscribe-pacing-remaining-ports`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(sdk): pace re-subscribes in the <port> port`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A port's suite fails before your change: skip that port, report the baseline failure.
- A port has no hook to drive a timer from tests (no injectable clock): implement pacing without the 10 s timeout for that port only, and say so prominently.
