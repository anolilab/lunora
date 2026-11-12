# Plan 603 — Go, Ruby, Kotlin and Dart SDKs honour the live-query retry hint

> **Executor instructions**: Follow this plan step by step, ONE PORT PER RUN, on a machine whose
> toolchain for that port is installed (see "Toolchains"). Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" occurs, stop and
> report. Do NOT update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat <BASE>..HEAD -- sdks/<port>` → prints nothing.

**Baseline:** head of `feat/improve-546-retry-java-swift` (plan 602), on `1f55a1679` (PR #1550),
2026-11-12
**Status:** BLOCKED (toolchain missing on the planning machine: `go`; `ruby` ≥ 3.0 — only system
Ruby 2.6.10 is installed and it cannot parse the port's endless methods (`def close = …`,
`client.rb:95-97`); `kotlinc`; `dart`). Not executed blind.
**Priority / effort / risk:** P3 / M / LOW. **Category:** feature parity. **Depends on:** plans
600-602. **Branch (suggested):** `feat/improve-546-retry-go-ruby-kotlin-dart`, one commit per port.

## 0. Headline finding

After plans 601-602, four ports (python, rust, java, swift) honour `error.retryAfterMs`; go, ruby,
kotlin and dart still ignore it (`sdks/README.md` row "Subscription retry hint", footnote ¹³), so
`subscription_retry_after_hint` cannot be added to `protocol/conformance-cases.json` yet.

## 1. Current state (audit)

### The rule (identical in plans 601-603)

1. **Schedule** only for an `error` frame that names a registered QUERY subscription (not a shape)
   whose `error.retryAfterMs` is a JSON number, finite, ≥ 0 (not a bool or string), clamped to the
   port's existing max retry-after (60 000). `TOKEN_EXPIRED` returns before routing and schedules
   nothing. The error callback fires exactly as today.
2. **One pending retry per subscription id**: a monotonic deadline in a map; a newer hint replaces it.
3. **Cancel** on any `ack`/`data`/`delta`/`resume`/`settled` frame for the id (one check right
   after the frame's `type`/`id` are read, before the switch — not inside the data branch, which
   PR #1553 rewrites), on unsubscribe; clear the map on attach, detach and close. An error
   without a valid hint leaves an entry alone.
4. **Pulled firing**: `RetryDueSubscriptions(now)` / `retry_due_subscriptions(now)` /
   `retryDueSubscriptions(now)` sends, for each due entry still registered, ONE cold subscribe
   frame (same id/path/args, no since fields), clearing the stored cursor/epoch; returns the
   count; does nothing without an attached socket; builds under the lock, sends outside it.
   `NextSubscriptionRetryAt()` / `next_subscription_retry_at` / `nextSubscriptionRetryAt` returns
   the earliest deadline or null.
5. Goldens: `protocol/fixtures/ws-frames.json` → `subscriptionRetry` (`seedFrame`, `hintFrame`,
   `laterHintFrame`, `retryFrame`, `cancelFrames`, `noRetryFrames`).

Worked examples of the same rule, already merged into this branch's history: Python
(`sdks/python/lunora/client.py`, `retry_due_subscriptions`), Rust (`sdks/rust/src/client.rs`),
Java (`sdks/java/src/dev/lunora/Client.java`), Swift (`sdks/swift/Sources/Lunora/Client.swift`) and
their tests (`test_subscription_retry.py`, `tests/retry_cases/mod.rs`,
`SubscriptionRetryTest.java`, `SubscriptionRetryTests.swift`). Copy the closest one's structure.

### Per port (entry points, all on `1f55a1679`)

| Port   | File                             | Clock (already used for the flush window)                                                    | Max hint                                                             | Lifecycle / frame entry points                                                                                                                                      |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| go     | `sdks/go/lunora/client.go`       | `time.Time` (`flushNotBefore`, line 163) — use `time.Now()` (monotonic reading)              | the `retryAfterMs` clamp used for flushes (find the 60 000 constant) | `AttachSocket` 463, `DetachSocket` 506, `Close` 701, `Subscribe` 1164 (returns `Unsubscribe`), `ResendSubscriptions` 1365, `HandleFrame` 1445, `case "error":` 1545 |
| ruby   | `sdks/ruby/lib/lunora/client.rb` | `Lunora.monotonic_now` (line 149, seconds)                                                   | `MAX_RETRY_AFTER_MS` (47)                                            | `attach_socket` 445, `detach_socket` 478, `close` 572, `subscribe` 607, `resend_subscriptions` 697, `handle_frame` 727, `when "error"` → `deliver_error` 947        |
| kotlin | `sdks/kotlin/src/Client.kt`      | `System.nanoTime()` (comment at 513)                                                         | `MAX_RETRY_AFTER_MS` (`Offline.kt:97`)                               | `attachSocket` 560, `detachSocket` 608, `close` 764, `subscribe` 912, `resendSubscriptions` 1063, `handleFrame` 1096                                                |
| dart   | `sdks/dart/lib/src/client.dart`  | a `Stopwatch` (`replay.dart:61`, `elapsedMilliseconds`) — add one to the client the same way | `maxRetryAfterMs` (`errors.dart:154`)                                | `attachSocket` 237, `detachSocket` 306, `close` 472, `resendSubscriptions` 761, `handleFrame` 848                                                                   |

Tests: go — a new `sdks/go/lunora/subscription_retry_test.go` (`package lunora`, model
`socket_test.go`); ruby — `sdks/ruby/test/test_subscription_retry.rb` (Minitest, model
`test_socket_session.rb`; the runner requires every `test/test_*.rb`); kotlin — a
`subscriptionRetryCases()` function in a new `sdks/kotlin/test/SubscriptionRetryTest.kt`, called
from `main` in `ConformanceTest.kt` (`build.sh` compiles `src` + `test` and runs
`dev.lunora.ConformanceTestKt`); dart — a new `sdks/dart/test/retry_cases.dart` called from
`test/conformance.dart` the way `socket_cases.dart` is. Cases: the eight listed in plan 602 J3
(at-hint cold frame with `t0`/`t1` bracketing and `d - 1ms`; callback still fires; later hint
replaces; each cancel frame; each no-retry frame; unsubscribe/detach/attach/close; shape error;
clamp). Dart: deadlines are milliseconds on the client's own `Stopwatch`, so
`retryDueSubscriptions({int? nowMs})` defaults to `_clock.elapsedMilliseconds` and
`nextSubscriptionRetryAt` returns that unit. The test cannot read the stopwatch, so instead of
`t0`/`t1` bracketing it asserts `retryDueSubscriptions(nowMs: d - 1) == 0`,
`retryDueSubscriptions(nowMs: d) == 1`, and for the clamp that a 3 600 000 ms hint's deadline is
not later than a 60 000 ms hint's deadline taken right after it.

## Toolchains

| Port   | Test command (`sdks/run-all.sh`)                                           | Lint (`sdks/lint-all.sh`)                                                                                                         |
| ------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| go     | `cd sdks/go && go test ./... -race -count=1 -v`                            | `gofmt -l lunora` empty; `go vet ./lunora/...`                                                                                    |
| ruby   | `cd sdks/ruby && ruby -Ilib -e 'Dir["test/test_*.rb"].each {               | f                                                                                                                                 | require File.expand_path(f) }'` (Ruby ≥ 3.0) | `rubocop` |
| kotlin | `cd sdks/kotlin && bash build.sh` (kotlinc + a JDK)                        | `ktlint src/*.kt test/*.kt`                                                                                                       |
| dart   | `cd sdks/dart && dart pub get --offline && dart run test/conformance.dart` | `dart format --output=none --set-exit-if-changed --line-length=160 --language-version=3.6 lib test && dart analyze --fatal-infos` |

## Scope

Per port: its client file, one new test file, its runner hook (kotlin `ConformanceTest.kt` main,
dart `test/conformance.dart`), and its cell in `sdks/README.md` plus its method names in footnote
¹³. When the fourth of these lands (all eight ✅): add `subscription_retry_after_hint` to
`protocol/conformance-cases.json` and make every suite record it — that is a separate change
touching all eight runners.

**Out of scope:** `protocol/fixtures/**`, the data/delta branch bodies, the socket-session test
files PR #1553 edits.

## Done criteria (per port)

- [ ] the port's test command passes with the new cases; lint clean
- [ ] red without the deadline-store line
- [ ] only in-scope files changed; one commit `feat(sdk): re-subscribe at the live-query retry hint in the <port> port`

## STOP conditions

- The port's JSON decoding cannot tell a bool from a number.
- An existing test would need its assertion changed.
- The toolchain is missing or the wrong version (do not install one to get past it).

## Maintenance notes

PR #1553 edits the same four client files' frame dispatch; keep the cancel one line, before the
switch.
