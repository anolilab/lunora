# Plan 600 — Shared golden for the subscription retry hint, docs and SDK matrix row

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; your reviewer maintains the index.
>
> **Drift check (run first)**:
> `git -C <worktrees>/lunora-wt-sdk-retry-fixture diff --stat 1f55a1679..HEAD -- protocol/fixtures/ws-frames.json packages/client/__tests__/protocol-conformance.test.ts sdks/README.md apps/docs/src/content/docs/concepts/realtime.mdx shared/ai-knowledge-data.ts`
> → prints nothing. If it prints anything, STOP.

**Baseline:** `1f55a1679` (head of `fix/improve-546-backoff-client-retry`, PR #1550), 2026-11-12
**Status:** DONE — APPROVED after 1 revision (ack before the 60 s window); PR #1578, branch `feat/improve-546-retry-fixture`
**Priority / effort / risk:** P2 / S / LOW. **Category:** tests + docs. **Depends on:** plan 546
phase 1 (the base branch). **Branch:** `feat/improve-546-retry-fixture`.

## 0. Headline finding

Phase 1 (PR #1550) made the shard send `error.retryAfterMs` on a failing live query and made
`@lunora/client` re-subscribe once at that hint. Nothing shared pins that behaviour: the golden
fixtures every SDK reads (`protocol/fixtures/ws-frames.json`) have no frame carrying the field, so
the eight non-JS ports cannot be checked against the reference, and neither the docs nor the SDK
capability matrix mention the retry.

## 1. Current state (audit)

- `protocol/README.md` §5.2 (on the base branch) already documents the field: the `error` row is
  `{ type, id?, error: { code?, message?, hint?, why?, retryAfterMs? }, message? }`, followed by:
  "The server sets `error.retryAfterMs` (milliseconds) on a live subscription's refresh-failure
  frame and on the answer to a failed retry. A client that ignores it sees the same frames as
  before. A client that honours it re-subscribes that id once, at the hint; any `data`, `ack`,
  `resume` or `settled` frame for the id, an unsubscribe or a disconnect cancels the pending
  re-subscribe." Do not edit `protocol/README.md`.
- The reference client (`packages/client/src/lunora-client.ts`, base branch):
  `scheduleSubscriptionRetry(state, retryAfterMs)` ignores anything that is not a finite number
  ≥ 0, cancels a pending timer for the id, then `setTimeout(retryAfterMs)`; on fire, if the
  subscription is still registered it calls `resnapshotSubscription(state)`, which sets the ack
  to idle, CLEARS `serverCursor`/`serverEpoch` and sends one `subscribe` frame (so the retry is a
  cold subscribe, no `sinceSeq`). Cancels: `handleDataMessage` (data/delta),
  `ackAndAdvanceCursor` (ack/resume/settled), last unsubscribe, `markShardPendingAck` (socket
  open/close), `close()`.
- `protocol/fixtures/ws-frames.json` — top-level keys in order: `$comment`, `clientFrames`,
  `stream`, `closeSequences`, `whisperFrames`, `serverFrames` (7 cases; the `error` case is
  `{"name":"error","frame":{"id":"sub_1","type":"error","error":{"code":"FORBIDDEN_SHARD","message":"nope"}},"expect":{"kind":"error","id":"sub_1","code":"FORBIDDEN_SHARD","message":"nope"}}`;
  the last case is `complete`), `pageDeltaFrames`, `refreshBatchFrames`, `shape`,
  `malformedFrames`, `identityChange` (the LAST key). `clientFrames["subscribe-cold"]` is
  `{"id":"sub_1","query":{"args":{"channel":"general"},"functionPath":"messages:list","table":"messages:list"},"type":"subscribe"}`.
- All eight SDK suites iterate `serverFrames` wholesale: each subscribes `messages:list`
  `{"channel":"general"}` (id `sub_1`), feeds the frame, and for an `error` case asserts the
  error callback fired once with `expect.code` (python, java, swift, rust also the message). None
  compares unknown frame keys, so an extra field in the FRAME is invisible to them.
- `packages/client/__tests__/protocol-conformance.test.ts`: `describe("ws-frames fixtures", …)`
  reads the file as `ws`; the `it.each` "delivers error frame %s" (≈ line 599-621) subscribes,
  `latestSocket().open()`, `receive(testCase.frame)`, asserts code/message. It uses REAL timers
  and never closes the client. Helpers `makeWsClient()` (≈462), `latestSocket()` (≈452),
  `fnRef`, `table`. The interface `WsFixtures` (≈ line 470-492) types the file.
- `packages/client/__tests__/subscription-retry-after.test.ts` (phase 1) is the pattern for a
  fake-timer test of this feature: `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in
  `afterEach`, `vi.advanceTimersByTime(n)`, and it counts `subscribe` frames for the id on
  `socket.sent`.
- `protocol/conformance-cases.json` `required` — every name there turns all eight SDK suites red
  until each covers it. `sdks/README.md` footnote 7 states the rule: that file "may only require
  behaviour every port has". Four ports (go, ruby, kotlin, dart) cannot be built on this machine,
  so this plan adds NO name to it.
- `sdks/README.md` "Capability matrix" table (≈ line 122-161); the row `| 503 at upgrade retried |`
  is followed by `| Multi-tab leader election |`. Footnotes run ¹ … ¹²; ¹² is the paragraph
  starting `¹² **The identity frame is not adopted.**` (≈ line 322-323), followed by a blank line
  and `**The two argument rows are one problem with two halves, …`.
- Docs: `apps/docs/src/content/docs/concepts/realtime.mdx` section `## How an update reaches a
subscriber` (≈ line 46-76) explains re-execution, then `## Reconnect` (≈ line 78). No docs page
  mentions a failing re-run or the retry. `shared/ai-knowledge-data.ts` is GENERATED from every
  docs `.mdx` by `node scripts/build-ai-knowledge.js` and checked by the CI job "Lint (generated
  files)" (`pnpm run lint:generated`), so a docs edit must regenerate and commit it.
- Framework adapters: no change needed (reviewer evidence, not executor work): `react`, `vue`,
  `solid`, `svelte`, `angular` and `db` contain no subscription-frame handling; their only
  `WebSocket`/`onmessage` code is the separate voice-agent socket. `react-native` only wraps the
  `WebSocket` constructor to add auth headers.

## 2. Existing seams (do not reinvent)

- The fixture's per-case `$comment` convention (see the `complete` case).
- The `WsFixtures` interface and `it.each(table(...))` pattern in `protocol-conformance.test.ts`.
- The mock socket in `protocol-conformance.test.ts` (`latestSocket().sent` holds JSON strings).

## 3. The behavioural contract to preserve

- Every existing fixture key and case stays byte-identical. The top-level `$comment` line is NOT
  edited (open PR #1553 rewrites exactly that line; editing it creates a conflict).
- `protocol/conformance-cases.json` is not edited.
- `pnpm` client tests stay green; all eight SDK suites stay green (a new `serverFrames` case with
  the same `expect` keys as the existing `error` case guarantees it for the ones that cannot run
  here).

## 4. Design decisions

- **One new `serverFrames` case** (`error-retry-after`) proves a port that ignores the field
  still delivers the error — run by all eight suites with no code change. Chosen over a
  required conformance name, which would turn the four unbuildable ports red.
- **A separate top-level group `subscriptionRetry`** carries what a port that honours the hint
  must do (hint frame, cancelling frames, frames that must not schedule, the exact retry frame).
  Separate, like `pageDeltaFrames`, because the `serverFrames` loop runs everything wholesale.
- **Retry frame = `subscribe-cold`** even after a seed with a cursor: the reference clears the
  cursor before the retry.

## 5. Steps

Worktree: `<worktrees>/lunora-wt-sdk-retry-fixture` (branch
`feat/improve-546-retry-fixture`, already checked out, `pnpm install` already done). Work only
inside it. Prefix every shell call with `cd <worktrees>/lunora-wt-sdk-retry-fixture &&`.

### Step 1: Add the `serverFrames` case

In `protocol/fixtures/ws-frames.json`, append ONE object to the END of the `serverFrames` array
(after the `complete` case), formatted with 4-space indentation like its neighbours:

```json
{
    "name": "error-retry-after",
    "$comment": "A live query whose refresh failed: the shard backs it off and `error.retryAfterMs` asks the client to re-subscribe once after that many milliseconds (protocol/README.md 5.2). Otherwise an ordinary subscription error, so a port that ignores the field delivers exactly this; what a port that honours it does is pinned by `subscriptionRetry`.",
    "frame": {
        "id": "sub_1",
        "type": "error",
        "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 5000 }
    },
    "expect": { "kind": "error", "id": "sub_1", "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed" }
}
```

**Verify**: `python3 -c "import json;d=json.load(open('protocol/fixtures/ws-frames.json'));print(len(d['serverFrames']), d['serverFrames'][-1]['name'])"` → `8 error-retry-after`

### Step 2: Add the `subscriptionRetry` group

Add a new top-level key `subscriptionRetry` as the LAST key of the root object (after
`identityChange`; add the comma after `identityChange`'s closing brace):

```json
"subscriptionRetry": {
    "$comment": "What a client that honours `error.retryAfterMs` does (protocol/README.md 5.2), as the reference `@lunora/client` does it. Setup: `sub_1` subscribes `messages:list` {\"channel\":\"general\"} on an open socket and receives `seedFrame`. `hintFrame` schedules exactly ONE re-subscribe of `sub_1`, `retryAfterMs` later; nothing is sent before that, and exactly `retryFrame` is sent at it: a COLD subscribe (no sinceSeq/sinceEpoch), because the retry asks for a fresh snapshot. A newer hint for the id (`laterHintFrame`) replaces the pending one. Each of `cancelFrames`, received while the retry is pending, cancels it: the server has answered. An unsubscribe, a socket close or open, and closing the client cancel it too. None of `noRetryFrames` schedules anything: no hint, a hint that is not a finite number >= 0, or a TOKEN_EXPIRED frame, which belongs to the socket and is never routed to a subscription. A port that ignores the field is conforming (the `error-retry-after` case in `serverFrames` is what it must still deliver); sdks/README.md records which ports honour it.",
    "subscriptionId": "sub_1",
    "seedFrame": { "id": "sub_1", "type": "data", "data": { "n": 1 }, "cursor": 12, "epoch": "e1" },
    "hintFrame": {
        "id": "sub_1",
        "type": "error",
        "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 5000 }
    },
    "retryAfterMs": 5000,
    "laterHintFrame": {
        "id": "sub_1",
        "type": "error",
        "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 8000 }
    },
    "laterRetryAfterMs": 8000,
    "retryFrame": {
        "id": "sub_1",
        "query": { "args": { "channel": "general" }, "functionPath": "messages:list", "table": "messages:list" },
        "type": "subscribe"
    },
    "cancelFrames": [
        { "name": "ack", "frame": { "id": "sub_1", "type": "ack" } },
        { "name": "data", "frame": { "id": "sub_1", "type": "data", "data": { "n": 2 }, "cursor": 13, "epoch": "e1" } },
        { "name": "delta", "frame": { "id": "sub_1", "type": "delta", "delta": { "n": 2 }, "cursor": 13, "epoch": "e1" } },
        { "name": "resume", "frame": { "id": "sub_1", "type": "resume", "cursor": 13, "epoch": "e1" } },
        { "name": "settled", "frame": { "id": "sub_1", "type": "settled", "cursor": 13, "epoch": "e1" } }
    ],
    "noRetryFrames": [
        {
            "name": "no-hint",
            "frame": { "id": "sub_1", "type": "error", "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed" } }
        },
        {
            "name": "negative-hint",
            "frame": { "id": "sub_1", "type": "error", "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": -1 } }
        },
        {
            "name": "string-hint",
            "frame": { "id": "sub_1", "type": "error", "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": "5000" } }
        },
        {
            "name": "token-expired",
            "frame": { "id": "sub_1", "type": "error", "error": { "code": "TOKEN_EXPIRED", "message": "token expired", "retryAfterMs": 5000 } }
        }
    ]
}
```

Then format the file the way the repo does: `pnpm exec prettier --write protocol/fixtures/ws-frames.json`.

**Verify**:
`python3 -c "import json;d=json.load(open('protocol/fixtures/ws-frames.json'));print(list(d)[-1], len(d['subscriptionRetry']['cancelFrames']), len(d['subscriptionRetry']['noRetryFrames']))"`
→ `subscriptionRetry 5 4`, and
`git diff -U0 protocol/fixtures/ws-frames.json | grep '^-' | grep -v '^---'` → at most one
line, the `}` that gained a comma after `identityChange` (no other existing line removed). If
prettier rewrote existing lines, STOP.

### Step 3: Hold the reference client to the new fixture

In `packages/client/__tests__/protocol-conformance.test.ts`:

1. Add `subscriptionRetry` to the `WsFixtures` interface with the fields of Step 2
   (`cancelFrames`/`noRetryFrames` as `{ name: string; frame: Record<string, unknown> }[]`,
   frames as `Record<string, unknown>`, numbers as `number`, `subscriptionId: string`).
2. In the existing "delivers error frame %s" test, add `client.close();` as its last statement
   (the new `error-retry-after` case arms a real 5 s timer otherwise; `close()` cancels it).
3. Add a new `describe("ws-frames subscriptionRetry", …)` block at the END of the file, with
   `beforeEach(() => { vi.useFakeTimers(); })` and `afterEach(() => { vi.useRealTimers(); })`
   (import `beforeEach`/`afterEach`/`vi` from `vitest` if not already imported). Read the group
   as `readFixture("ws-frames.json").subscriptionRetry`. A local helper
   `retryFramesSent(socket)` returns `socket.sent.map((raw) => JSON.parse(raw))` filtered to
   `type === "subscribe"` and `id === fixture.subscriptionId`. Each test: `makeWsClient()`,
   `client.subscribe(fnRef("messages:list"), { channel: "general" }, () => undefined, { onError: () => undefined })`,
   `latestSocket().open()`, `receive(seedFrame)`, then record `const before = retryFramesSent(socket).length`.
   Tests (each ends with `client.close()`):
    - "re-subscribes once, cold, at the hint": receive `hintFrame`; `vi.advanceTimersByTime(retryAfterMs - 1)`
      → count still `before`; `vi.advanceTimersByTime(1)` → `before + 1`, and the last subscribe
      frame `toStrictEqual(fixture.retryFrame)`; then `socket.receive({ id, type: "ack" })` (revision 1:
      without an ack the reference's unacked-subscribe watchdog re-sends after
      `RESUBSCRIBE_ACK_TIMEOUT_MS` = 10 s, which is not the hint) and
      `vi.advanceTimersByTime(60_000)` → still `before + 1`.
    - "a later hint replaces the pending one": receive `hintFrame`; advance 1000; receive
      `laterHintFrame`; advance `retryAfterMs - 1000` → `before`; advance `laterRetryAfterMs - retryAfterMs + 1000`
      → `before + 1`.
    - `it.each` over `cancelFrames` "frame %s cancels the pending re-subscribe": receive
      `hintFrame`; advance 1000; receive the case frame; advance 60_000 → `before`.
    - `it.each` over `noRetryFrames` "frame %s schedules nothing": receive the case frame; advance
      60_000 → `before`.
    - "closing the client cancels it": receive `hintFrame`; `client.close()`; advance 60_000 →
      `before` (count on the same socket object, captured before closing).
      Use `expect.hasAssertions()` in each, as the file does.

**Verify**: `cd packages/client && pnpm exec vitest run __tests__/protocol-conformance.test.ts`
→ all pass, including 2 + 5 + 4 + 1 = 12 new tests and one new "delivers error frame
error-retry-after".

### Step 4: Prove the new tests go red without the client feature

Temporarily delete the line
`this.scheduleSubscriptionRetry(state, (message.error as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);`
from `packages/client/src/lunora-client.ts`, re-run the Step 3 command, record which tests fail,
then restore it with `git checkout -- packages/client/src/lunora-client.ts`.

**Verify**: with the line removed, "re-subscribes once, cold, at the hint" and "a later hint
replaces the pending one" FAIL; after `git checkout`, `git status --short packages/client/src`
prints nothing and the Step 3 command passes again.

### Step 5: SDK capability matrix row and footnote

In `sdks/README.md`:

1. Insert a row directly AFTER the `| 503 at upgrade retried |` row (keep the column widths of
   the table; prettier will align it):
   `| Subscription retry hint       | ❌¹³   | ❌¹³ | ❌¹³ | ❌¹³ | ❌¹³  | ❌¹³ | ❌¹³   | ❌¹³ |`
2. Insert a footnote paragraph after the ¹² paragraph and before `**The two argument rows …`
   (blank line on each side):

    ```
    ¹³ **The live-query retry hint is ignored here.** A subscription whose re-run fails is backed off
    by the shard, and its `error` frame carries `error.retryAfterMs` (protocol/README.md §5.2).
    `@lunora/client` re-subscribes that id once at the hint, cold; a newer hint replaces the
    pending retry, and any `data`, `delta`, `ack`, `resume` or `settled` frame for the id, an
    unsubscribe, a socket close or open, or `close()` cancels it. A port that ignores the field
    delivers the error as before, so the subscription stays on it until a write touches its
    tables after the backoff window or the socket reconnects. The goldens are `subscriptionRetry`
    in `protocol/fixtures/ws-frames.json`; it is not in `conformance-cases.json`, which may only
    require behaviour every port has.
    ```

Then `pnpm exec prettier --write sdks/README.md`.

**Verify**: `grep -c "¹³" sdks/README.md` → `2` (the row line and the footnote line), and
`git diff --numstat sdks/README.md` → `11	0	sdks/README.md` (1 row + 10 footnote lines incl.
the blank line; 0 removed). A different count is fine only if prettier re-wrapped the footnote;
any removed line means you changed an existing line — undo that.

### Step 6: Docs — what happens when a live query's re-run fails

In `apps/docs/src/content/docs/concepts/realtime.mdx`, add a section between the end of
`## How an update reaches a subscriber` and `## Reconnect`:

```mdx
## When a re-run fails

If a subscription's query throws when a write re-runs it, the subscriber receives an `error`
for that subscription and the subscription stays registered. The shard then backs it off: a
query that keeps failing is not re-run on every write, only after a delay that starts at one
second and doubles per failed retry up to 60 seconds. The error frame carries that delay as
`retryAfterMs`, and `@lunora/client` (and every framework binding built on it) re-subscribes
once when it elapses. A successful re-run delivers data as usual and ends the backoff; a retry
that fails again is answered with the next, longer delay. A data frame, an unsubscribe or a
reconnect cancels a pending retry.

Errors a retry cannot fix (access denied, a result over the size limit) carry no delay and end
the subscription. The non-JS SDKs differ per language; see the capability matrix in
`sdks/README.md`.
```

Then regenerate the derived knowledge file: `node scripts/build-ai-knowledge.js`, and format:
`pnpm exec prettier --write apps/docs/src/content/docs/concepts/realtime.mdx`.

**Verify**: `git status --short` lists exactly `apps/docs/src/content/docs/concepts/realtime.mdx`,
`shared/ai-knowledge-data.ts`, `protocol/fixtures/ws-frames.json`,
`packages/client/__tests__/protocol-conformance.test.ts`, `sdks/README.md` (all ` M`).
Then `node scripts/build-ai-knowledge.js && git diff --stat shared/ai-knowledge-data.ts` shows
the same diff as before (re-running is idempotent).

### Step 7: Gates and commits

Run:

- `cd packages/client && pnpm exec vitest run __tests__/protocol-conformance.test.ts __tests__/subscription-retry-after.test.ts` → all pass
- `pnpm --filter "@lunora/client" run lint:eslint -- __tests__/protocol-conformance.test.ts` (if
  the script does not accept a path, run `pnpm --filter "@lunora/client" run lint:eslint`) → exit 0
- `pnpm exec prettier --check protocol/fixtures/ws-frames.json sdks/README.md apps/docs/src/content/docs/concepts/realtime.mdx packages/client/__tests__/protocol-conformance.test.ts` → all formatted
- `cd sdks/python && python3 -m unittest discover -s tests -t . 2>&1 | tail -3` → `OK`
- `cd sdks/java && bash build.sh 2>&1 | tail -1` → starts with `OK`

Commit (explicit paths, never `git add -A`), three commits:

1. `test(protocol): add golden frames for the subscription retry hint` — `protocol/fixtures/ws-frames.json`, `packages/client/__tests__/protocol-conformance.test.ts`
2. `docs(sdks): add the subscription retry hint to the capability matrix` — `sdks/README.md`
3. `docs(realtime): explain how a failing live query is retried` — `apps/docs/src/content/docs/concepts/realtime.mdx`, `shared/ai-knowledge-data.ts`

Each message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
Header ≤ 100 chars, body lines ≤ 100. Never `--no-verify`; if a hook fails, fix the cause.

**Verify**: `git log --oneline 1f55a1679..HEAD` → 3 commits; `git status --short` → empty.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## Scope

**In scope (only these files):** `protocol/fixtures/ws-frames.json`,
`packages/client/__tests__/protocol-conformance.test.ts`, `sdks/README.md`,
`apps/docs/src/content/docs/concepts/realtime.mdx`, `shared/ai-knowledge-data.ts` (generated).

**Out of scope:** `protocol/conformance-cases.json` (would turn four unbuildable ports red);
`protocol/README.md` (done in phase 1); the top-level `$comment` of `ws-frames.json` (PR #1553
rewrites it); any `packages/*/src` file; any `sdks/<lang>/` code (plans 601-603).

## Commands you will need

| Purpose      | Command (from the worktree root)                                                    | Expected        |
| ------------ | ----------------------------------------------------------------------------------- | --------------- |
| Client tests | `cd packages/client && pnpm exec vitest run __tests__/protocol-conformance.test.ts` | all pass        |
| Format       | `pnpm exec prettier --write <file>`                                                 | exit 0          |
| Lint         | `pnpm --filter "@lunora/client" run lint:eslint`                                    | exit 0          |
| Docs derived | `node scripts/build-ai-knowledge.js`                                                | exit 0          |
| Python SDK   | `cd sdks/python && python3 -m unittest discover -s tests -t .`                      | `OK`            |
| Java SDK     | `cd sdks/java && bash build.sh`                                                     | last line `OK…` |

Do NOT run: `pnpm run build`, `pnpm run build:packages`, `pnpm run test` (whole repo), `pnpm -r …`,
`pnpm run test:workerd`, `bash sdks/run-all.sh`.

## Test plan

New tests in `packages/client/__tests__/protocol-conformance.test.ts` (12, Step 3), modelled on
`packages/client/__tests__/subscription-retry-after.test.ts`. Red-without-fix: Step 4.
The new `serverFrames` case is exercised by the existing "delivers error frame %s" test and by
every SDK suite's `serverFrames` loop.

## Done criteria

- [ ] Step 1 and Step 2 verify commands print the expected values
- [ ] `cd packages/client && pnpm exec vitest run __tests__/protocol-conformance.test.ts __tests__/subscription-retry-after.test.ts` exits 0
- [ ] Step 4 recorded the two named tests failing with the line removed
- [ ] `git diff --stat 1f55a1679..HEAD` lists only the five in-scope files
- [ ] python and java SDK suites still pass
- [ ] 3 commits, clean `git status`

## STOP conditions

- The reference's retry frame is not byte-equal to `retryFrame` (e.g. it carries `sinceSeq`, or
  extra keys): STOP and report the frame it sent — do not change the fixture to match.
- A `cancelFrames` case does NOT cancel in the reference (e.g. `delta`): STOP and report which.
- A `noRetryFrames` case DOES schedule in the reference: STOP and report which.
- prettier rewrites lines of `ws-frames.json` outside the two insertions.
- Any SDK suite you run goes red.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- When all eight ports honour the hint, add `subscription_retry_after_hint` to
  `protocol/conformance-cases.json` and make each suite drive `subscriptionRetry` under it.
- Merge with PR #1553 (`feat/sdk-row-delta-chunk`): it rewrites the top-level `$comment` and adds
  `pageDeltaFrames` cases and `connect-with-page-delta-caps`; this plan touches none of those
  lines. In `sdks/README.md` it edits the row-delta row and footnote ⁷; this plan inserts a row
  after "503 at upgrade retried" and a footnote after ¹². Both should merge cleanly.
