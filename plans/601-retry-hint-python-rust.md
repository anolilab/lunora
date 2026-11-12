# Plan 601 — Python and Rust SDKs honour the live-query retry hint

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat <BASE>..HEAD -- sdks/python sdks/rust` → prints
> nothing (`<BASE>` is given in your dispatch message: the commit your branch was cut from).

**Baseline:** head of `feat/improve-546-retry-fixture` (plan 600), which sits on `1f55a1679`
(PR #1550), 2026-11-12
**Status:** DONE — APPROVED after 2 revisions (footnote 13 lead; Python timer passes its deadline so an early-firing handle keeps the retry, `ee3eee44b`); PR #1579, branch `feat/improve-546-retry-python-rust`
**Priority / effort / risk:** P2 / M / LOW. **Category:** feature parity. **Depends on:** plan 600
(the `subscriptionRetry` fixture group). **Branch:** `feat/improve-546-retry-python-rust`.

## 0. Headline finding

When a live query's re-run fails, the shard backs it off and sends the subscription's `error`
frame with `error.retryAfterMs`. The reference JS client re-subscribes once at that hint; the
Python and Rust ports ignore the field, so a subscription on a quiet table stays on its error
until a write happens to touch its tables or the socket reconnects.

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
2. **One pending retry per subscription id.** Store a monotonic DEADLINE
   (`now + delay`) in a map keyed by subscription id. A newer hint for the same id REPLACES the
   stored deadline (the ports mint one id per `subscribe` call, so the id plays the part of the
   reference's subscription key).
3. **Cancel** (remove the id's entry) when any `ack`, `data`, `delta`, `resume` or `settled`
   frame for that id arrives (whether or not it decodes), when the subscription is
   unsubscribed, and clear the WHOLE map when a socket is attached, when it is detached, and on
   `close()`. An `error` frame WITHOUT a valid hint leaves an existing entry alone (reference
   behaviour).
4. **Firing is pulled, not timed.** These ports have no timer of their own (the transport is
   driven by the caller; the existing precedent is `FlushReport.retry_after_ms`, "for a caller
   that schedules its own retry"). So each port gets two public methods:
    - `retry_due_subscriptions(now)` — for every entry whose deadline ≤ `now`: remove the entry;
      if no socket is attached return 0 WITHOUT removing anything; if the id is still a
      registered query subscription, clear its stored resume cursor and epoch (and its acked
      flag, where the port has one) and send ONE cold subscribe frame for it — the same frame
      `subscribe` sends first: same id, function path and args, no `sinceSeq`/`sinceEpoch`.
      Returns how many frames it sent. Frames are built under the lock and sent outside it,
      as `resend_subscriptions` does.
    - `next_subscription_retry_at()` — the earliest stored deadline, or none.
      The caller arms one timer for `next_subscription_retry_at()` after each frame and calls
      `retry_due_subscriptions()` when it fires. Python ALSO drives it itself from
      `connect_and_run` (step P4), because that loop owns a timer seam already.
5. **The retry frame** must equal `subscriptionRetry.retryFrame` in the fixture (which is
   `clientFrames["subscribe-cold"]`), even after `seedFrame` set a cursor.

### Python — `sdks/python/lunora/client.py` (1800 lines)

- Imports at lines 21-49; no `import time` yet. `from .submit import (…)` at line 38 — `submit.py`
  defines `MAX_RETRY_AFTER_MS = 60_000` (line 99).
- `_Subscription` (318-340): `id`, `function_path`, `args`, `acked`, `server_cursor`,
  `server_epoch`, …; shapes are `_ShapeSubscription` in `self._shapes`.
- `LunoraClient.__init__` (374-465): state lives under `self._lock` (`threading.Lock`);
  `self._call_later` (437) is the injected timer seam (`loop.call_later` unless a test replaces
  it); `self._subs: dict[str, _Subscription]` (444); `self._send` (449).
- `_attach` (492-510) installs the sender under the lock; `detach_socket` (524-545) clears it.
- `close()` (790-802).
- `subscribe` (999-1032): mints `sub_N`, `build_subscribe_frame(sub_id, function_path, args)`;
  its `unsubscribe()` closure pops `self._subs` under the lock.
- `resend_subscriptions` (1126-1151): builds frames under the lock, sends outside — copy this
  structure.
- `_dispatch` (1170-1265): `kind = frame.get("type")` at 1185, then branches for `ack` (1186),
  `data`/`delta` (1192, calls `_handle_data`), `error` (1195, calls `_handle_error`),
  `resume`/`settled` (1201-1208, call `_advance`).
- `_handle_error` (1327-1344): TOKEN_EXPIRED returns early (1330-1334); else builds
  `SubscriptionError`, looks up `sub` and `shape`, returns
  `{"kind": "error", "id": sub_id, "code": code, "message": message}`.
- `_run_socket`'s `read_inbound` (≈1579-1607): `descriptor = self.handle_frame(frame)` inside a
  `try` at ≈1597; `loop` is in scope.
- Test helpers: `tests/_fixtures.py` `load("ws-frames.json")`; the fake clock `_FakeClock` in
  `tests/test_connect_and_run.py:125-148` (`now`, `monotonic()`, `call_later`, `advance`), used
  by `test_a_hinted_rate_limit_is_retried_on_a_healthy_socket` (≈942) with the setup helper
  `_run_refused_once` (≈905-940), which patches `lunora.submit.time` and sets
  `client._call_later = clock.call_later`.

### Rust — `sdks/rust/src/client.rs` (1892 lines)

- `use std::time::Instant;` at line 8. `MAX_RETRY_AFTER_MS: i64 = 60_000` in `src/offline.rs:91`
  (re-exported from `lib.rs`).
- `pub(crate) struct Subscription` (392-…): `function_path`, `args`, `cursor: Option<Value>`,
  `epoch: Option<Value>`, `on_error`, ….
- `pub struct Client` (503-…): `subscriptions: HashMap<String, Subscription>` (535), `send`,
  `flush_not_before: Option<Instant>` (545); constructor initialises fields at ≈603.
- `attach_socket` (623-636), `detach_socket` (650-…), `close` (811-822), `subscribe` (1060),
  `resend_subscriptions` (1152-1188, `build_subscribe_frame(id, &entry.function_path,
&entry.args, None, cursor, epoch)?` — returns `Result`), `unsubscribe(&mut self, id)` (1190).
- `handle_frame(&mut self, raw) -> Result<Option<String>, ClientError>` (1230-…): computes `kind`
  and `id` at 1240-1241, then `match kind.as_str()`: `"data" | "delta"` (1244), `"resume" |
"settled"` (1296), `"error"` (1320-1350: TOKEN_EXPIRED early return at 1327; handlers for the
  subscription and the shape at 1343-1349), `"complete"`, … There is NO `"ack"` arm (falls to
  the default).
- Tests: `tests/conformance.rs` is the only test binary on purpose (comment at lines 18-21: a
  second `tests/*.rs` compiles as its own binary). Case files are subdirectory modules
  (`mod socket_cases;` → `tests/socket_cases/mod.rs`, plain `pub fn`s) wrapped in `#[test]`s at
  the FOOT of `conformance.rs` (e.g. `fn whisper_frames_join_send_and_deliver() {
socket_cases::whisper_frames_join_send_and_deliver(); }`). `tests/socket_cases/mod.rs` has
  `recording_sender` / `take` helpers (lines 28-38) and reads fixtures via a path helper — copy
  what you need.

## 2. Existing seams (do not reinvent)

`resend_subscriptions` (frame building and the lock pattern), `build_subscribe_frame`,
`MAX_RETRY_AFTER_MS`, Python's `_call_later` seam and `_FakeClock`, Rust's subdirectory test
modules with `#[test]` wrappers.

## 3. The behavioural contract to preserve

- A port given no hint behaves exactly as today; every existing test stays green.
- `handle_frame` keeps its return value (Python's descriptor gains ONE optional key,
  `retryAfterMs`, only when a retry was scheduled).
- No new dependency; no `conformance-cases.json` change.

## 4. Design decisions

- **Pulled, not timed** (rule 4): Rust's `Client` is `&mut self` with no interior mutability, so a
  timer callback could not reach it; the ports' precedent for a server delay is to report it to
  the caller. Python additionally arms its existing `_call_later` seam inside `connect_and_run`.
- **Deadlines on the port's monotonic clock** (`time.monotonic()` / `Instant`), and the due check
  takes `now` as an argument, so tests drive time explicitly with no sleep and no clock mock
  (except the Python `connect_and_run` test, which uses the file's existing `_FakeClock`).

## 5. Steps

Worktree: given in your dispatch message (`/Users/daniel.bannert/Projects/lunora-wt-sdk-retry-py-rust`).
Work only inside it; prefix every shell call with `cd <worktree> &&`.

### Python

**P1. State and parsing.** In `sdks/python/lunora/client.py`: add `import math` and `import time`
to the stdlib imports (alphabetical), add `MAX_RETRY_AFTER_MS` to the `from .submit import (…)`
list. Add a module-level helper next to `_frame_key`:

```python
def _retry_after_ms(envelope: Any) -> Optional[float]:
    """The server's retry hint on a subscription error, or ``None`` when it sent none we can honour."""
    delay = envelope.get("retryAfterMs") if isinstance(envelope, dict) else None
    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 0:
        return None
    return min(delay, MAX_RETRY_AFTER_MS)
```

In `__init__`, next to `self._subs`, add
`self._pending_retries: dict[str, float] = {}` with a `#:` comment: the `time.monotonic()`
deadline of the one re-subscribe a retry hint asked for, per query subscription id.

**Verify**: `cd sdks/python && python3 -m unittest discover -s tests -t . 2>&1 | tail -1` → `OK`

**P2. Schedule and cancel.**

- `_handle_error`: after `sub` is looked up, if `sub is not None` and
  `(hint := _retry_after_ms(env)) is not None`, set
  `self._pending_retries[sub_id] = time.monotonic() + hint / 1000` and add `"retryAfterMs": hint`
  to the returned descriptor. Shapes never schedule.
- `_dispatch`: immediately after `kind = frame.get("type")`, add
  `if kind in ("ack", "data", "delta", "resume", "settled"): self._pending_retries.pop(_frame_key(frame.get("id")), None)`
  with a one-line comment (the server answered, so a pending retry is moot). Put it HERE, not
  inside `_handle_data` (another open PR rewrites that function).
- `subscribe`'s `unsubscribe()` closure: `self._pending_retries.pop(sub_id, None)` under the lock.
- `_attach` (inside its first `with self._lock:`), `detach_socket` (inside its lock) and `close()`
  (take the lock): `self._pending_retries.clear()`.

**P3. Pull API.** Add, after `resend_subscriptions`:

- `def retry_due_subscriptions(self, now: Optional[float] = None) -> int:` docstring: re-subscribe
  every subscription whose retry hint has elapsed; `now` is a `time.monotonic()` reading,
  defaulting to the current one; returns the number of frames sent. Implement rule 4 exactly:
  under the lock read `self._send` (return 0 if None), pop due entries, for each still in
  `self._subs` set `acked = False`, `server_cursor = None`, `server_epoch = None` and build
  `build_subscribe_frame(sub.id, sub.function_path, sub.args)`; send outside the lock.
- `def next_subscription_retry_at(self) -> Optional[float]:` the minimum stored deadline under the
  lock, or `None`.

**P4. Drive it from `connect_and_run`.** In `read_inbound`, right after
`descriptor = self.handle_frame(frame)` succeeds (inside the same `try`, after the call), add:

```python
                        hint = descriptor.get("retryAfterMs")
                        if hint is not None:
                            # The hint is a deadline only `retry_due_subscriptions` acts on, so a
                            # timer a later frame made moot sends nothing.
                            (self._call_later or loop.call_later)(hint / 1000, self.retry_due_subscriptions)
```

(match the surrounding indentation).

**Verify**: `cd sdks/python && python3 -m unittest discover -s tests -t . 2>&1 | tail -1` → `OK`

**P5. Tests.** Create `sdks/python/tests/test_subscription_retry.py` (model: the head of
`tests/test_socket_session.py` — module docstring, `sys.path.insert`, imports, `load`). Fixture:
`RETRY = load("ws-frames.json")["subscriptionRetry"]`. Helper `_open()` returns
`(client, sent)` after `client = LunoraClient("https://app.example", client_id="client-test")`,
`client.attach_socket(sent.append)`, `client.subscribe("messages:list", {"channel": "general"}, lambda _v: None, lambda _e: None)`,
`client.handle_frame(RETRY["seedFrame"])`, `sent.clear()`. Tests (`unittest.TestCase`):

1. `test_re_subscribes_once_cold_at_the_hint`: `t0 = time.monotonic()`; handle `hintFrame`;
   `t1 = time.monotonic()`; `d = client.next_subscription_retry_at()`; assert
   `t0 + 5 <= d <= t1 + 5`; `retry_due_subscriptions(d - 0.001) == 0` and `sent == []`;
   `retry_due_subscriptions(d) == 1` and `sent == [RETRY["retryFrame"]]`;
   `retry_due_subscriptions(d + 60) == 0`; `next_subscription_retry_at() is None`.
2. `test_the_error_still_reaches_the_callback_and_reports_the_hint`: errors list gets one
   `SubscriptionError` with code `SUBSCRIPTION_REFRESH_FAILED`; descriptor `retryAfterMs == 5000`.
3. `test_a_later_hint_replaces_the_pending_one`: hint → `d1`; `laterHintFrame` → `d2`; `d2 > d1`;
   `retry_due_subscriptions(d1) == 0`; `retry_due_subscriptions(d2) == 1`.
4. `test_each_cancel_frame_cancels` — loop `RETRY["cancelFrames"]` with `self.subTest(case=…)`, a
   fresh `_open()` each: hint, case frame, `next_subscription_retry_at() is None`,
   `retry_due_subscriptions(time.monotonic() + 3600) == 0`, and no subscribe frame in `sent`.
5. `test_no_retry_frames_schedule_nothing` — loop `RETRY["noRetryFrames"]` likewise.
6. `test_unsubscribe_cancels`, `test_detach_cancels`, `test_attach_cancels` (attach a second
   recorder; nothing subscribe-typed reaches it from `retry_due_subscriptions(far)`),
   `test_close_cancels` (each: hint, action, `next_subscription_retry_at() is None`).
7. `test_a_shape_error_never_schedules`: `client.subscribe_shape("messages", {}, lambda _r: None)`
   gives `shape_1`; handle an error frame with id `shape_1` and `retryAfterMs: 5000` →
   `next_subscription_retry_at() is None`.
8. `test_the_hint_is_clamped`: hint frame with `retryAfterMs: 3600000` → `d <= t1 + 60`.
   Then ONE test in `tests/test_connect_and_run.py`, placed right after
   `test_a_hinted_rate_limit_is_retried_on_a_healthy_socket` and built from the same fake socket and
   `_FakeClock` machinery that file already uses (read how its socket is created and frames are
   pushed): connect, subscribe `messages:list` `{"channel": "general"}`, deliver `hintFrame`, assert
   `clock.delays` gained `5.0`; with `lunora.client.time` patched to the clock's `monotonic`,
   `clock.advance(4.999)` → no new subscribe frame on the socket, `clock.advance(0.001)` → exactly
   one (equal to `retryFrame`). If that file's machinery cannot deliver a server frame to the client,
   skip this one test and say so in NOTES (do not build new machinery).

**Verify**: `cd sdks/python && python3 -m unittest tests.test_subscription_retry -v 2>&1 | tail -3`
→ `OK`, ≥ 11 tests; full suite `python3 -m unittest discover -s tests -t . 2>&1 | tail -1` → `OK`.

**P6. Red without the fix.** Comment out the line in `_handle_error` that stores the deadline,
re-run `python3 -m unittest tests.test_subscription_retry`, record the failures, restore it
(`git diff sdks/python/lunora/client.py` must again show your intended change only).

**Verify**: with the line out, tests 1, 2, 3 and 8 fail; restored, the suite is `OK`.

**P7. Commit (Python).** `git add sdks/python/lunora/client.py sdks/python/tests/test_subscription_retry.py sdks/python/tests/test_connect_and_run.py sdks/README.md`
after flipping the python cell (step R6 shows the README edit; do it for python now) and commit
`feat(sdk): re-subscribe at the live-query retry hint in the python port`.

### Rust

**R1. State and parsing.** In `sdks/rust/src/client.rs`: change the import to
`use std::time::{Duration, Instant};`, import `MAX_RETRY_AFTER_MS` the way `submit.rs` does
(`use crate::offline::MAX_RETRY_AFTER_MS;` or via the existing `use crate::…` list). Add a private
field to `Client`: `pending_retries: HashMap<String, Instant>` with a `///` comment (the monotonic
deadline of the one re-subscribe a retry hint asked for, per query subscription id); initialise it
in the constructor. Add a free function near `advance`:

```rust
/// The server's retry hint on a subscription error, or `None` when it sent none this client can honour.
fn retry_after(envelope: Option<&Value>) -> Option<Duration> {
    let delay = envelope?.get("retryAfterMs")?.as_f64()?;

    (delay.is_finite() && delay >= 0.0).then(|| Duration::from_secs_f64(delay.min(MAX_RETRY_AFTER_MS as f64) / 1000.0))
}
```

(`as_f64` is `None` for a string or a bool, which is what rule 1 wants.)

**R2. Schedule and cancel.**

- In `handle_frame`, right after `let id = …;` and BEFORE the `match`, add
  `if matches!(kind.as_str(), "ack" | "data" | "delta" | "resume" | "settled") { self.pending_retries.remove(&id); }`
  with a one-line comment.
- In the `"error"` arm, after the two handler calls: if `self.subscriptions.contains_key(&id)` and
  `retry_after(envelope)` is `Some(delay)`, insert `Instant::now() + delay` for `id.clone()`.
- `unsubscribe`: `self.pending_retries.remove(id);`. `attach_socket`, `detach_socket`, `close`:
  `self.pending_retries.clear();`.

**R3. Pull API.** After `resend_subscriptions`, add (doc comments in the file's style):

- `pub fn retry_due_subscriptions(&mut self, now: Instant) -> Result<usize, ClientError>` —
  rule 4: `let Some(send) = &self.send else { return Ok(0) };` (clone the sender handle the way
  the type allows — `FrameSender` is an `Arc`/`Box` closure; check its definition and follow
  `resend_subscriptions`), collect due ids, remove them, for each id still in
  `self.subscriptions` set `cursor = None`, `epoch = None` and build
  `build_subscribe_frame(&id, &entry.function_path, &entry.args, None, None, None)?`; send all
  after building; return the count.
- `pub fn next_subscription_retry_at(&self) -> Option<Instant>` — `self.pending_retries.values().min().copied()`.

**Verify**: `cd sdks/rust && cargo build 2>&1 | tail -2` → `Finished`.

**R4. Tests.** Create `sdks/rust/tests/retry_cases/mod.rs` with plain `pub fn`s (model:
`tests/socket_cases/mod.rs`; copy its `recording_sender`/`take` helpers and its fixture loading),
mirroring Python tests 1, 3, 4, 5, 6, 7, 8 (Rust has no descriptor, so test 2 becomes: the error
handler fired once with code `SUBSCRIPTION_REFRESH_FAILED`). Times: `let t0 = Instant::now();`,
handle, `let t1 = Instant::now();`, `d = next_subscription_retry_at().unwrap()`, assert
`t0 + Duration::from_secs(5) <= d && d <= t1 + Duration::from_secs(5)`;
`retry_due_subscriptions(d - Duration::from_millis(1))` → `Ok(0)`; `(d)` → `Ok(1)` and the sent
frame equals `retryFrame` (compare `serde_json::Value`s). In `tests/conformance.rs` add
`mod retry_cases;` after `mod socket_cases;` (with a one-line comment: not manifest cases yet, so
only the `#[test]` wrappers run them) and one `#[test]` wrapper per case at the END of the file.

**Verify**: `cd sdks/rust && cargo test 2>&1 | grep -E "^test result|FAILED|panicked"` → every
`test result: ok`, the new tests listed as `ok`.

**R5. Red without the fix.** Comment out the `insert` in the `"error"` arm, `cargo test`, record
the failing tests, restore.

**Verify**: with it out, the at-hint, later-hint and clamp tests fail; restored, all pass.

**R6. Lint, matrix, commit (Rust).**

- `cd sdks/rust && cargo fmt && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
  → exit 0.
- In `sdks/README.md`, in the row `| Subscription retry hint |`, change the `python` cell (P7)
  and the `rust` cell from `❌¹³` to `✅¹³`; extend footnote ¹³ by appending (one sentence per
  port, after the existing text):
  `Python and Rust honour it through a pulled deadline: the client records one per subscription,
and \`retry_due_subscriptions(now)\` sends the due re-subscribes while
  \`next_subscription_retry_at()\` says when to call it next — the caller's timer, as for
  \`FlushReport.retry_after_ms\`; Python's \`connect_and_run\` arms that timer itself.`(Python's commit adds the sentence for Python; Rust's commit edits it to name both.)
Then`pnpm exec prettier --write sdks/README.md`if`pnpm` works in the worktree, else leave
  the table aligned by hand.
- Commit `sdks/rust/src/client.rs sdks/rust/tests/conformance.rs sdks/rust/tests/retry_cases/mod.rs sdks/README.md`
  as `feat(sdk): re-subscribe at the live-query retry hint in the rust port`.

Every commit message ends with a blank line and
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; header ≤ 100 chars, body lines ≤ 100;
never `--no-verify`, never `git add -A`.

## Commands you will need

| Purpose      | Command (from the worktree root)                                                 | Expected |
| ------------ | -------------------------------------------------------------------------------- | -------- |
| Python tests | `cd sdks/python && python3 -m unittest discover -s tests -t .`                   | `OK`     |
| One file     | `cd sdks/python && python3 -m unittest tests.test_subscription_retry -v`         | `OK`     |
| Rust tests   | `cd sdks/rust && cargo test`                                                     | all `ok` |
| Rust lint    | `cd sdks/rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings` | exit 0   |

`ruff` is not installed here: do not install it; match the file's existing formatting (line
length 160, double quotes). Do NOT run: `pnpm run build*`, `pnpm run test`, `pnpm -r …`,
`pnpm run test:workerd`, `bash sdks/run-all.sh`.

## Scope

**In scope:** `sdks/python/lunora/client.py`, `sdks/python/tests/test_subscription_retry.py`
(new), `sdks/python/tests/test_connect_and_run.py` (one test), `sdks/rust/src/client.rs`,
`sdks/rust/tests/retry_cases/mod.rs` (new), `sdks/rust/tests/conformance.rs` (`mod` line +
wrappers), `sdks/README.md` (two cells + footnote ¹³ sentence).

**Out of scope:** `protocol/**` (fixtures are read-only here), `protocol/conformance-cases.json`,
the other six ports, `_handle_data` / the `data`/`delta` arm bodies (PR #1553 rewrites them),
`sdks/python/tests/test_socket_session.py` and `sdks/rust/tests/socket_cases/mod.rs` (PR #1553
edits them), any `packages/**`.

## Test plan

Listed in P5 and R4; pattern files `sdks/python/tests/test_socket_session.py` and
`sdks/rust/tests/socket_cases/mod.rs`. Red-without-fix: P6, R5.

## Done criteria

- [ ] `cd sdks/python && python3 -m unittest discover -s tests -t .` → `OK`, ≥ 203 tests (192 before)
- [ ] `cd sdks/rust && cargo test` → all ok; `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` exit 0
- [ ] P6 and R5 recorded red runs
- [ ] `git diff --stat <BASE>..HEAD` lists only in-scope files
- [ ] 2 commits (python, rust), clean `git status`

## STOP conditions

- The cold retry frame a port builds differs from `retryFrame` in a way that needs a change to
  `build_subscribe_frame`.
- An existing test fails after your change and the fix would mean changing what it asserts.
- Python's `connect_and_run` cannot reach the injected `_call_later` for this path.
- Rust: `FrameSender` cannot be used to send after `&mut self` work without restructuring
  `resend_subscriptions`-style code.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- PR #1553 (`feat/sdk-row-delta-chunk`) edits the same `client.py`/`client.rs`; the only shared
  region is `_dispatch` (Python) / the head of `handle_frame` (Rust), where this plan adds one
  line. Expect a small textual conflict there at most.
- When every port honours the hint, add a manifest name and drive these cases from it.
