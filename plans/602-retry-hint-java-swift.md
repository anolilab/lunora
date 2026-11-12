# Plan 602 — Java and Swift SDKs honour the live-query retry hint

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat <BASE>..HEAD -- sdks/java sdks/swift` → prints
> nothing (`<BASE>` is given in your dispatch message).

**Baseline:** head of `feat/improve-546-retry-python-rust` (plan 601), on `1f55a1679` (PR #1550),
2026-11-12
**Status:** DONE — APPROVED; PR #1580, branch `feat/improve-546-retry-java-swift`
**Priority / effort / risk:** P2 / M / LOW. **Category:** feature parity. **Depends on:** plans 600
(fixture group `subscriptionRetry`) and 601 (same design, and the README footnote sentence this
plan extends). **Branch:** `feat/improve-546-retry-java-swift`.

## 0. Headline finding

When a live query's re-run fails, the shard backs it off and sends the subscription's `error`
frame with `error.retryAfterMs`. The reference JS client re-subscribes once at that hint; the Java
and Swift ports ignore the field, so a subscription on a quiet table stays on its error until a
write touches its tables or the socket reconnects. Plan 601 gave Python and Rust the behaviour
with a pulled deadline; this plan gives Java and Swift the same.

## 1. Current state (audit)

### The rule every port must implement (shared by plans 601-603)

The reference (`packages/client/src/lunora-client.ts`, `scheduleSubscriptionRetry` /
`cancelSubscriptionRetry`) and the goldens in `protocol/fixtures/ws-frames.json` →
`subscriptionRetry` define it. In port terms:

1. **When to schedule.** Only when an `error` frame names a registered QUERY subscription (an id
   in the port's query-subscription map — NOT a shape id) and `error.retryAfterMs` is a JSON
   number that is finite and ≥ 0 (a bool, a string, a negative number, NaN or a missing field
   schedules nothing). A `TOKEN_EXPIRED` error is handled before routing and schedules nothing.
   Clamp the delay to the port's existing `MAX_RETRY_AFTER_MS` (60 000; the server never sends
   more). The error is still delivered to the error callback exactly as today.
2. **One pending retry per subscription id.** Store a monotonic DEADLINE (`now + delay`) in a
   map keyed by subscription id. A newer hint for the same id REPLACES the stored deadline.
3. **Cancel** (remove the id's entry) when any `ack`, `data`, `delta`, `resume` or `settled`
   frame for that id arrives (whether or not it decodes), when the subscription is
   unsubscribed, and clear the WHOLE map when a socket is attached, when it is detached, and on
   `close()`. An `error` frame WITHOUT a valid hint leaves an existing entry alone.
4. **Firing is pulled, not timed.** Two public methods:
    - `retryDueSubscriptions(now)` — if no socket is attached return 0 without touching anything;
      else for every entry whose deadline ≤ `now`: remove it; if the id is still a registered
      query subscription, set its `cursor` and `epoch` to null and send ONE cold subscribe frame
      (same id, function path and args, no `sinceSeq`/`sinceEpoch` — the frame `subscribe` sends
      first). Returns the number of frames sent. Build frames under the lock, send outside it, as
      `resendSubscriptions` does.
    - `nextSubscriptionRetryAt…` — the earliest stored deadline, or null.
5. **The retry frame** must equal `subscriptionRetry.retryFrame` (=`clientFrames["subscribe-cold"]`),
   even after `seedFrame` set a cursor.

### Java — `sdks/java/src/dev/lunora/Client.java` (2136 lines)

- `private static final class Subscription` (232-…): `functionPath`, `args`, `onError`,
  `Object cursor`, `Object epoch` (≈246-247). `subscriptions` is a `LinkedHashMap` (222), all state
  under `synchronized (lock)`. `long flushNotBefore = System.nanoTime();` (496) shows the clock:
  `System.nanoTime()`, compared wrap-safely (`a - b > 0`, see `Submit.java:720`).
  `Offline.MAX_RETRY_AFTER_MS = 60_000L` (`Offline.java:126`).
- `attachSocket` (531-…), `detachSocket` (594-…), `close()` (842-…, sets `sender = null` under the
  lock at ≈849), `subscribe` (1256-1289: id `"sub_" + nextId`; `buildSubscribeFrame(id,
functionPath, args, null, null, null)`; the returned `Runnable` removes the entry under the lock
  and sends `unsubscribe`), `resendSubscriptions` (1440-1486: builds frames under the lock with
  `buildSubscribeFrame(entry.getKey(), s.functionPath, s.args, null, s.cursor, s.epoch)`).
- `handleFrame(String raw)` (1494-…): computes `kind` (1508) and `id` (1509), then
  `switch (kind)`: `"data", "delta"` (1516), `"resume", "settled"` (1584), `"error"` (1616-1657:
  TOKEN_EXPIRED returns at 1633-1637; then under the lock looks up `entry` and `shape` and collects
  their `onError`s). There is NO `"ack"` case.
- Tests: `build.sh` compiles `src` + `test` and runs `dev.lunora.ConformanceTest`'s `main`, which
  calls each test class's `static void run()` (e.g. `SocketSessionTest.run();` at line 78).
  `SocketSessionTest.java` is the pattern: `import static dev.lunora.ConformanceTest.check;`,
  `fixture("ws-frames.json")`, `List<Map<String,Object>> sent = new ArrayList<>(); client.attachSocket(sent::add, null);`.
  Frames compare via `Key.stableStringify(a).equals(Key.stableStringify(b))`.

### Swift — `sdks/swift/Sources/Lunora/Client.swift` (1596 lines)

- `final class Subscription` (241-…): `functionPath`, `args`, `onError`, `var cursor: Any?`,
  `var epoch: Any?`. Client state: `var send: LunoraFrameSender?` (203),
  `var subscriptions: [String: Subscription]` (204), `private var shapes` (205), guarded by
  `withLock { … }` (234). Monotonic clock already used: `ProcessInfo.systemUptime`
  (`storedFlushNotBefore: TimeInterval`, ≈335). `lunoraMaxRetryAfterMs = 60_000`
  (`Offline.swift:93`). A JSON number that is not a Bool: `value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID()`
  (see `static func intValue`, 668-672) — use `number.doubleValue`.
- `attachSocket` (431-…), `detachSocket` (454-…), `close()` (528-544, sets `send = nil` under
  `withLock`), `subscribe` (931-…, id `"sub_\(nextID)"`, returns an unsubscribe closure that
  removes the entry under `withLock`), `resendSubscriptions` (1060-…: `try?
LunoraClient.buildSubscribeFrame(id:functionPath:args:sinceSeq:sinceEpoch:)` under the lock).
- `handleFrame(_:)` (1173) parses then calls `private func dispatch(_ frame:)` (≈1183): `let kind`,
  `let id = frame["id"] as? String`, then `switch kind`: `case "ack": return kind`, `"data",
"delta"`, `"resume", "settled"`, `"error"` (1279-1303: TOKEN_EXPIRED returns early; handlers
  from `subscriptions[id]?.onError` and `shapes[id]?.onError` under `withLock`).
- Tests: XCTest, `@testable import Lunora` (so `internal` members are reachable). Pattern:
  `Tests/LunoraTests/SocketSessionTests.swift` (`var sent: [[String: Any]] = []`,
  `client.attachSocket { sent.append($0) }`, `canonical(...)` to compare frames, `fixture(...)`
  helpers — find where `fixture`/`canonical` are defined and reuse them).
  Swift tests need full Xcode: EVERY swift command must be prefixed with
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

## 2. Existing seams (do not reinvent)

`resendSubscriptions` (lock pattern), `buildSubscribeFrame`, `MAX_RETRY_AFTER_MS` /
`lunoraMaxRetryAfterMs`, the `NSNumber`-not-Bool guard, the test helpers named above, and the
Python/Rust implementation from plan 601 in this branch's history
(`git show HEAD~1 -- sdks/rust/src/client.rs`, `git show HEAD~2 -- sdks/python/lunora/client.py`)
as a worked example of the same rule.

## 3. The behavioural contract to preserve

No hint ⇒ exactly today's behaviour; `handleFrame` return values unchanged; no new dependency; no
`conformance-cases.json` change; all existing tests green.

## 4. Design decisions

Pulled deadline, same as plan 601 (rule 4): these transports have no timer; the precedent is
`FlushReport.retryAfterMs` "for a caller that schedules its own retry". `now` is an argument so
tests need no sleep.

## 5. Steps

Worktree: given in your dispatch message (`/Users/daniel.bannert/Projects/lunora-wt-sdk-retry-java-swift`).
Work only inside it; prefix every shell call with `cd <worktree> &&`.

### Java

**J1. State, parsing, schedule, cancel** in `Client.java`:

- Field next to `subscriptions`: `private final Map<String, Long> pendingRetries = new HashMap<>();`
  with a `/** … */` comment (the `System.nanoTime()` deadline of the one re-subscribe a retry hint
  asked for, per query subscription id; guarded by `lock`). Import `HashMap` if needed.
- A private static helper:
    ```java
    /** The server's retry hint on a subscription error in nanoseconds, or null when it sent none this client can honour. */
    private static Long retryAfterNanos(Map<String, Object> envelope) {
        if (!(envelope.get("retryAfterMs") instanceof Number number)) {
            return null;
        }
        double delay = number.doubleValue();
        if (Double.isNaN(delay) || Double.isInfinite(delay) || delay < 0) {
            return null;
        }
        return (long) (Math.min(delay, Offline.MAX_RETRY_AFTER_MS) * 1_000_000L);
    }
    ```
    (A JSON `true` parses as `Boolean`, not `Number`; check `Json.java` and confirm.)
- `handleFrame`: right after `String id = …;` add a cancel for
  `"ack", "data", "delta", "resume", "settled"` (`synchronized (lock) { pendingRetries.remove(id); }`),
  with a one-line comment.
- `"error"` case: inside the existing `synchronized (lock)` block, after `entry` is looked up:
  `Long delay = retryAfterNanos(envelope); if (entry != null && delay != null) { pendingRetries.put(id, System.nanoTime() + delay); }`.
- The unsubscribe `Runnable` in `subscribe`: `pendingRetries.remove(id);` inside its lock block.
  `attachSocket`, `detachSocket`, `close`: `pendingRetries.clear();` inside their lock blocks.

**J2. Pull API** after `resendSubscriptions` (Javadoc in the file's style):

- `public int retryDueSubscriptions()` → `return retryDueSubscriptions(System.nanoTime());`
- `public int retryDueSubscriptions(long nowNanos)` — rule 4; due means `deadline - nowNanos <= 0`.
- `public Long nextSubscriptionRetryAtNanos()` — the earliest deadline (compare wrap-safely) or null.

**Verify**: `cd sdks/java && bash build.sh 2>&1 | tail -1` → starts with `OK`.

**J3. Tests**: create `sdks/java/test/dev/lunora/SubscriptionRetryTest.java` (`final class`,
`static void run() throws IOException`, private static case methods, `check(...)` from
`ConformanceTest`), and add `SubscriptionRetryTest.run();` in `ConformanceTest.main` right after
`SocketSessionTest.run();`. Cases (the fixture group is
`(Map<String,Object>) fixture("ws-frames.json").get("subscriptionRetry")`; open = new client,
`attachSocket(sent::add, null)`, `subscribe("messages:list", Map.of("channel", "general"), v -> {}, errors::add, null)`,
`handleFrame(json(seedFrame))` — serialise fixture maps with `Json.write`/the helper the other tests
use — then `sent.clear()`):

1. at the hint, cold: `t0 = System.nanoTime()`, hint, `t1`; `d = nextSubscriptionRetryAtNanos()`;
   `d - (t0 + 5_000_000_000L) >= 0` and `(t1 + 5_000_000_000L) - d >= 0`;
   `retryDueSubscriptions(d - 1_000_000L) == 0` and `sent.isEmpty()`; `retryDueSubscriptions(d) == 1`
   and `sent` is exactly `[retryFrame]` (stableStringify compare); `retryDueSubscriptions(d + 60_000_000_000L) == 0`;
   `nextSubscriptionRetryAtNanos() == null`.
2. the error callback still fired once with code `SUBSCRIPTION_REFRESH_FAILED`.
3. a later hint replaces: `d1`, then `laterHintFrame` → `d2`, `d2 - d1 > 0`; `retryDue(d1) == 0`; `retryDue(d2) == 1`.
4. each `cancelFrames` entry (fresh client each): hint, frame, `nextSubscriptionRetryAtNanos() == null`, `retryDue(far) == 0`.
5. each `noRetryFrames` entry: frame, `next… == null`.
6. unsubscribe / detachSocket / attachSocket(new recorder) / close each cancel (`next… == null`).
7. a shape error (`subscribeShape` → `shape_1`, error frame with id `shape_1` and `retryAfterMs: 5000`) schedules nothing.
8. clamp: `retryAfterMs: 3600000` → `(t1 + 60_000_000_000L) - d >= 0`.

**Verify**: `cd sdks/java && bash build.sh 2>&1 | tail -1` → `OK — N assertions` with N > 935.

**J4. Red without the fix**: comment out the `pendingRetries.put` line, `bash build.sh`, record
the failing check message, restore.

**Verify**: it fails (non-zero exit, a check message from case 1) without the line; passes with it.

**J5. Lint and commit (Java)**: `cd sdks/java && mkdir -p out/javalint && javac -Xlint:all -Werror -d out/javalint src/dev/lunora/*.java test/dev/lunora/*.java`
→ exit 0 (`out/` is the build dir `build.sh` already uses; check it is git-ignored with
`git check-ignore -q sdks/java/out && echo ignored`). `google-java-format` is not installed: match
the file's formatting by hand (4-space indent, AOSP style, 100 columns). In `sdks/README.md` flip
the `java` cell of `| Subscription retry hint |` to `✅¹³` and change footnote ¹³'s sentence
"Python and Rust honour it through a pulled deadline: …" to name Java too, giving its method names
(`retryDueSubscriptions(now)` / `nextSubscriptionRetryAtNanos()`). Commit
`sdks/java/src/dev/lunora/Client.java sdks/java/test/dev/lunora/SubscriptionRetryTest.java sdks/java/test/dev/lunora/ConformanceTest.java sdks/README.md`
as `feat(sdk): re-subscribe at the live-query retry hint in the java port`.

### Swift

**S1. State, parsing, schedule, cancel** in `Client.swift`:

- `var pendingRetries: [String: TimeInterval] = [:]` next to `subscriptions` (doc comment: the
  `ProcessInfo.systemUptime` deadline of the one re-subscribe a retry hint asked for, per query
  subscription id; guarded by the lock).
- A `static func retryAfterSeconds(_ envelope: [String: Any]) -> TimeInterval?` next to `intValue`:
  `NSNumber` that is not a Bool, `doubleValue` finite and ≥ 0, `min(delay, Double(lunoraMaxRetryAfterMs)) / 1000`.
- `dispatch`: right after `let id = …`, if `kind` is one of `ack`, `data`, `delta`, `resume`,
  `settled` and `id` is non-nil, `withLock { pendingRetries[id] = nil }` (one-line comment).
- `"error"` case: inside its `withLock`, when `subscriptions[id] != nil` and
  `retryAfterSeconds(envelope)` is non-nil, set
  `pendingRetries[id] = ProcessInfo.processInfo.systemUptime + delay`.
- `subscribe`'s unsubscribe closure, `attachSocket`, `detachSocket`, `close`: remove / `removeAll()`
  inside their existing `withLock` blocks.

**S2. Pull API** after `resendSubscriptions` (doc comments in the file's style):

- `@discardableResult public func retryDueSubscriptions(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Int` — rule 4.
- `public var nextSubscriptionRetryAt: TimeInterval? { withLock { pendingRetries.values.min() } }`.

**Verify**: `cd sdks/swift && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build 2>&1 | tail -2` → `Build complete!`

**S3. Tests**: create `sdks/swift/Tests/LunoraTests/SubscriptionRetryTests.swift`
(`final class SubscriptionRetryTests: XCTestCase`, `@testable import Lunora`) with the same eight
cases as J3 (times in seconds: `d - 0.001`, `t0 + 5 <= d`, `d <= t1 + 5`, clamp `d <= t1 + 60`).

**Verify**: `cd sdks/swift && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test 2>&1 | grep -E "Executed|error:" | tail -3`
→ `Executed N tests, with 0 failures`, N ≥ 45 (37 before).

**S4. Red without the fix**: comment out the `pendingRetries[id] = …systemUptime + delay` line,
re-run `swift test --filter SubscriptionRetryTests`, record failures, restore.

**S5. Lint and commit (Swift)**: `cd sdks/swift && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift format lint --recursive --strict Sources/Lunora Tests`
→ no output, exit 0 (the repo pins swift-format 6.3; this machine has 6.4 — report any finding in
NOTES and fix only findings in YOUR new lines). README: flip the `swift` cell and add Swift's
names (`retryDueSubscriptions(now:)` / `nextSubscriptionRetryAt`) to footnote ¹³'s sentence.
Commit `sdks/swift/Sources/Lunora/Client.swift sdks/swift/Tests/LunoraTests/SubscriptionRetryTests.swift sdks/README.md`
as `feat(sdk): re-subscribe at the live-query retry hint in the swift port`.

Every commit message ends with a blank line and
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; header ≤ 100 chars, body lines ≤ 100;
never `--no-verify`, never `git add -A`.

## Commands you will need

| Purpose     | Command (from the worktree root)                                                                                                        | Expected           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Java tests  | `cd sdks/java && bash build.sh`                                                                                                         | last line `OK — …` |
| Java lint   | `cd sdks/java && javac -Xlint:all -Werror -d out/javalint src/dev/lunora/*.java test/dev/lunora/*.java`                                 | exit 0             |
| Swift tests | `cd sdks/swift && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`                                                  | 0 failures         |
| Swift lint  | `cd sdks/swift && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift format lint --recursive --strict Sources/Lunora Tests` | exit 0             |

Do NOT run: `pnpm run build*`, `pnpm run test`, `pnpm -r …`, `pnpm run test:workerd`,
`bash sdks/run-all.sh`.

## Scope

**In scope:** `sdks/java/src/dev/lunora/Client.java`, `sdks/java/test/dev/lunora/SubscriptionRetryTest.java`
(new), `sdks/java/test/dev/lunora/ConformanceTest.java` (one `run()` call),
`sdks/swift/Sources/Lunora/Client.swift`, `sdks/swift/Tests/LunoraTests/SubscriptionRetryTests.swift`
(new), `sdks/README.md` (two cells + footnote ¹³ sentence).

**Out of scope:** `protocol/**`, the other six ports, the `data`/`delta` case bodies (PR #1553
rewrites them), `SocketSessionTest.java` / `SocketSessionTests.swift` / `ConformanceTests.swift`
(PR #1553 edits them), any `packages/**`.

## Test plan

J3 and S3 (pattern: `SocketSessionTest.java`, `SocketSessionTests.swift`); red-without-fix J4, S4.

## Done criteria

- [ ] `bash build.sh` (java) → `OK`, more assertions than 935; `javac -Xlint:all -Werror` exits 0
- [ ] swift test → 0 failures, ≥ 45 tests; swift format lint clean on new lines
- [ ] J4 and S4 recorded red runs
- [ ] `git diff --stat <BASE>..HEAD` lists only in-scope files; 2 commits; clean `git status`

## STOP conditions

- `Json.java` parses a JSON boolean as a `Number`, or Swift's parser bridges a bool past the
  `CFBooleanGetTypeID` guard.
- An existing test fails and fixing it would change what it asserts.
- The cold frame differs from `retryFrame` in a way that needs `buildSubscribeFrame` changed.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

PR #1553 edits `Client.java`/`Client.swift` frame dispatch and `ConformanceTest.java`; the shared
regions are the line after `id` is computed in `handleFrame`/`dispatch` and the `run()` list in
`ConformanceTest.main`. Expect small textual conflicts there.
