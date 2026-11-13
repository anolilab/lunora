# Plan 610 — A subscription served by re-execution never receives a broadcast delta

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: branch `fix/improve-610-broadcast-delta-overlap` starts at
> `origin/alpha` `e365349c9`. `git log --oneline -1` → `e365349c9`.

**Baseline:** `e365349c9` (`origin/alpha`, 2026-11-13, after PR #1595 merged)
**Status:** TODO — owner decision 2026-11-13: option (b) prevent the overlap, plus the docs half of
(a); investigate broadcast authorization and fix it in the same change if it is real and bounded.
**Source:** review-bot finding on PR #1595 (§5.1.1 `delta.table` paragraph over-broad).

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (behaviour change for hand-written subclasses
  that mix `broadcastDelta` with re-execution) · **Category**: bug + docs

## 0. Headline finding

A `ShardDO` has two producers of `{"type":"delta","id","delta":{key,op,row?,table}}` frames:

- **Re-execution**: the query re-runs and the result is diffed. `table` follows #1595's read-set
  rule.
- **Legacy `broadcastDelta`** (`packages/do/src/shard-do.ts:6736-6800`): fans a write-side
  `MutationDelta` out to every subscription for which `matchesSubscription` (`:6703`, default
  `query.table === delta.table`) is true.

Nothing stops both from reaching ONE subscription id, which happens when a shard re-executes and also
calls `broadcastDelta` and the subscription's registered `table` matches. A throwaway test on
`ReexecShard` showed one id receiving re-execution deltas (`"__lunora__"`) and a broadcast delta
(`"messages:list"`). The client cannot tell them apart. The broadcast row also bypasses the
re-execution diff baseline, so no later delta removes it, and the client keeps a row its query does
not return.

## 1. Facts

**Broadcast `table`.** It is whatever the caller stamped. Via `createShardCtxDb({ broadcast })`
(`packages/shard-engine/src/ctx-db.ts:2967, 3764, 3799, 4683, 5187`) it is the written table. Under
the default matcher, a delivered frame's `table` equals the subscription's own registered `table`.

**Who receives a broadcast today:**

- An anonymous socket's table-only subscription (no `functionPath`).
- Any subscription WITH a `functionPath` whose registered `table` matches, including on an
  authenticated socket (`:6793` only skips function-less subscriptions on a socket with claims). An
  existing test asserts exactly that: `shard-do.socket-reauth.test.ts:1119`, expectation `[0, 1, 1]`.
- Never a shard with delivery authorization, where `broadcastDelta` throws `NOT_IMPLEMENTED`.

`@lunora/client` and all eight SDK ports register `table = functionPath`. No in-tree code calls
`broadcastDelta`: generated shards route the ctx-db `broadcast` hook to `recordChangedTable`. It is a
hook for hand-written subclasses (`packages/do/README.md` "Usage";
`apps/docs/src/content/docs/concepts/realtime.mdx` "There is also a lower-level `delta` frame").

**What "served by re-execution" means.** `resolveReactiveOutcome` (`shard-do.ts:~13710`) re-runs:

- every `__lunora_admin__:` path (`ADMIN_FUNCTION_PREFIX`) via `executeAdminSubscription`, on every
  shard;
- every `FLAGS_FUNCTION_PREFIX` path via `runFlagSubscriptionRead`;
- every other `functionPath` via `executeSubscription`. The base implementation returns `null` (no
  re-execution); generated shards and the test shards `ReexecShard` / `ReauthShard` override it.

**Authorization (item 2).** On a re-executing shard, a function-path subscription reached by a
broadcast gets the raw written row, which is not filtered by the subscriber's own query, its RLS
policies, column masks or tenant scoping. The re-execution path does apply those filters.
**Item 1's fix closes this:** such subscriptions no longer receive broadcasts. What stays reachable
is the documented contract:

- anonymous table-only subscriptions. Protocol §5.1: raw table deltas "are not claim-scoped", and an
  anonymous socket "keeps accepting table-only subscribes as before".
- function-path subscriptions on a shard that does NOT re-execute (a hand-written subclass). Such a
  shard has no query to run for a subscription, so the subclass's `broadcastDelta` +
  `matchesSubscription` override IS its delivery and filtering contract (documented on
  `matchesSubscription`).

Neither is filtered by RLS or masks. That stays, and the docs now say so explicitly. No further code
change is bounded enough to make (a shard-level "has RLS" signal does not exist for hand-written
subclasses: `rlsMetadata()` is codegen-only).

## 2. Design decisions

- **Skip, not refuse.** `broadcastDelta` skips every subscription the shard serves by re-execution
  and still delivers to the rest. _Rejected:_ throwing whenever re-execution is active. That would
  break table-only subscriptions on a subclass of a generated shard, and it would throw after the
  write committed, surfacing as a failed mutation.
- **"Served by re-execution"** = the subscription has a `functionPath`, AND (the path starts with
  `ADMIN_FUNCTION_PREFIX` or `FLAGS_FUNCTION_PREFIX`, OR the shard overrides `executeSubscription`).
  The override is detected as `this.executeSubscription !== ShardDO.prototype.executeSubscription`.
  _Rejected:_ "has a memo", which is absent until the first delivery, so a broadcast racing the seed
  would still leak through.
- **Visible, not silent:** one `console.warn` per shard instance, on the first skip, following the
  existing one-shot warning pattern (`// eslint-disable-next-line no-console -- <reason>` at
  `shard-do.ts:~10986`). No config knob.
- **Pre-release branch:** no shim. This is a behaviour change for hand-written subclasses that both
  re-execute and broadcast; it is noted in the commit body.

## 3. Steps

All commands are run from the worktree root.

### Step 1 — the rule (`packages/do/src/shard-do.ts`)

1. Add a private instance field near the other private fields of `ShardDO`:
   `private broadcastSkipWarned = false;`. Give it a one-line doc saying it holds the one-shot
   warning for subscriptions `broadcastDelta` skips because re-execution serves them.
2. Add a private method next to `broadcastDelta`:

```ts
    /**
     * Whether a subscription gets its updates by re-execution, which diffs the
     * query's own result. A broadcast row would bypass that diff baseline (no
     * later delta removes it) and the subscriber's RLS, masks and query filter,
     * so `broadcastDelta` must not reach such a subscription.
     * @returns `true` when the shard re-runs this subscription's query
     */
    private servedByReexecution(functionPath: string | undefined): boolean {
        if (!functionPath) {
            return false;
        }

        return (
            functionPath.startsWith(ADMIN_FUNCTION_PREFIX) ||
            functionPath.startsWith(FLAGS_FUNCTION_PREFIX) ||
            this.executeSubscription !== ShardDO.prototype.executeSubscription
        );
    }
```

If `@typescript-eslint/unbound-method` (or another rule) flags the prototype comparison, add ONE
line-scoped disable on that line with the reason
`-- identity comparison only, never called unbound`. No file-level disable. 3. In `broadcastDelta`'s inner loop, directly after the existing
`if (query === undefined || !this.matchesSubscription(query, delta)) { continue; }`, add:

```ts
if (this.servedByReexecution(query.functionPath)) {
    this.warnBroadcastSkipped();
    continue;
}
```

Add a private `warnBroadcastSkipped()` that returns early if `broadcastSkipWarned` is set,
otherwise sets it and calls `console.warn` once with:
`"[@lunora/do] broadcastDelta skipped a subscription this shard serves by re-execution; re-execution delivers its updates. Broadcast reaches only subscriptions the shard does not re-run."`
Put a line-scoped `// eslint-disable-next-line no-console -- …` on it, with the reason: a shard
that mixes the two mechanisms must hear about it once. 4. Update `broadcastDelta`'s doc comment to say that it skips subscriptions the shard serves by
re-execution (see `servedByReexecution`), and that the row it sends is the written row, not
filtered by RLS, masks or the subscriber's query; `matchesSubscription` is the only filter.
Update `matchesSubscription`'s doc only if it contradicts this.

Verify: `pnpm --filter "@lunora/do..." run build` → exit 0.

### Step 2 — tests (`@lunora/do`)

1. `packages/do/__tests__/shard-do.test.ts`, `describe("shardDO subscription delta push")`, after the
   test "a query that read two tables stamps the placeholder, not the first table, on a row delta",
   add `"a subscription served by re-execution never receives a broadcast delta"`:
    - Use `ReexecShard` and `createFakeWebSocket`.
    - Subscribe with `shard.driveMessage(ws, { id: "sub-1", query: { args: {}, functionPath: "messages:list", table: "messages:list" }, type: "subscribe" })`
      and outcome `{ result: [...filler(16), idRow("a")], tables: new Set(["members", "messages"]) }`.
    - Record `const start = ws.sent.length`.
    - Set the outcome to `[...filler(16), idRow("a"), idRow("b", { text: "hi" })]`, then
      `changedTableOnRpc = "messages"` and `await shard.writeRpc()`.
    - Call `(shard as unknown as { broadcastDelta: (delta: unknown) => void }).broadcastDelta({ key: "x", op: "insert", row: idRow("x", { text: "stray" }), table: "messages:list" })`.
    - Set the outcome to `[...filler(16), idRow("a"), idRow("b", { text: "hi" }), idRow("c")]` and
      `await shard.writeRpc()`.
    - Parse `ws.sent.slice(start)` and keep the `type === "delta"` frames. Assert their `delta.key`
      list `toStrictEqual(["b", "c"])`; no frame carries key `"x"`.
    - Wrap with `const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);` before
      the broadcast, assert `expect(warn).toHaveBeenCalledTimes(1)` after it, and `warn.mockRestore()`
      only AFTER the assertions.
2. Same file, next to the existing broadcast tests (after "broadcastDelta sends to matching
   subscribers only", `TestShard`), add
   `"broadcastDelta still reaches a table-only subscription on a shard that re-executes"`:
    - A `ReexecShard`; register a socket with
      `shard.registerSocket(ws, { subs: { t: { table: "messages" } } })` (anonymous, table-only).
    - Broadcast `{ key: "m1", op: "insert", row: { _id: "m1" }, table: "messages" }` via the cast.
    - Assert exactly one frame, `toMatchObject({ id: "t", type: "delta", delta: { table: "messages" } })`.
    - Check `ReexecShard` exposes `registerSocket`. If it does not, use the pattern the file already
      uses for `ReexecShard` sockets, and say so in NOTES.
3. `packages/do/__tests__/shard-do.socket-reauth.test.ts:1119`
   ("sends a table-only subscription persisted before the refusal no delta on a socket that carries
   claims"). `ReauthShard` overrides `executeSubscription`, so after the fix the `named`
   function-path subscription on the authenticated socket no longer receives the broadcast:
    - Change the expectation `[0, 1, 1]` → `[0, 1, 0]`.
    - Update the comment above it: the authenticated socket's table-only sub gets none, the anonymous
      table-only sub still gets one, and the named sub gets none because the shard serves it by
      re-execution, which applies its own RLS and query filter.
    - Do not change anything else in that test.
    - This is the item-2 evidence: a function-path subscriber on an authenticated socket no longer
      receives an unfiltered raw row.
4. Red-without-fix: temporarily make `servedByReexecution` `return false;`, then run
   `pnpm --filter "@lunora/do" run build` and
   `pnpm --filter "@lunora/do" exec vitest run __tests__/shard-do.test.ts -t "never receives a broadcast"`
   → must FAIL (key `"x"` present). Run the reauth test too (`-t "persisted before the refusal"` on
   `__tests__/shard-do.socket-reauth.test.ts`) → must FAIL. Restore, rebuild, both pass. Report the
   outputs. Never commit the reverted state.

Verify: `pnpm --filter "@lunora/do" run test` → all pass. If any OTHER existing test fails because
it relied on a function-path subscription receiving `broadcastDelta` on a re-executing shard, STOP and
report the test name. Do not edit it.

### Step 3 — docs

1. `protocol/README.md` §5.1, the paragraph beginning "`subscribe.query.args` is `encodeWire(args)`.
   `functionPath` selects the query the server re-executes; `table` addresses the legacy raw-delta
   fan-out". After the sentence ending "…compares it to `delta.table` verbatim." add:

    ```text
    A subscription the server serves by re-execution (every `__lunora_admin__:` and flag subscription,
    and every subscription with a `functionPath` on a shard that re-runs queries) never receives a
    `broadcastDelta` frame, so one subscription id is fed by exactly one of the two paths.
    ```

2. `protocol/README.md` §5.1.1, the `**`delta.table`.**` paragraph (starts "A row delta's `table` is
   a real table name only when the query's read set is"):
    - Make its first sentence say "A **re-execution** row delta's `table` …", keeping the rule as is.
    - Then add, before "A client MUST NOT route…":

        ```text
        A `broadcastDelta` frame (§5.1, legacy raw-delta fan-out) carries the string the server stamped on
        the write, which under the default matcher equals the subscription's own registered `table` (the
        written table, on the `createShardCtxDb` route); its `row` is the written row as stored, not
        filtered by the subscriber's query, row-level security or column masks.
        ```

    - Keep "A client MUST NOT route, key or filter by this field: the merge is by `key` / `_id` alone"
      (it holds on both paths).
    - Rewrap the whole paragraph evenly, about 100 columns like its current lines. Fix the short line
      "no user table has that name). The server diffs the".
3. `packages/client/src/delta-merge.ts`, the doc on `MutationDelta.table`: on a re-execution delta, it
   is the query's only read table or `"__lunora__"`; on a `broadcastDelta` frame, it is the string
   the server stamped (the subscription's registered `table`). The merge never uses it (protocol
   README §5.1.1). Docs only.
4. `sdks/README.md` footnote 7. Replace the sentence
   ``"`table` is the query's one read table, or `"__lunora__"` for a query that read several, none, or every table (Studio's admin reads); no port routes or keys by it."``
   with:

    ```text
    On a re-execution delta `table` is the query's one read table, or `"__lunora__"` for a query that read several, none, or every table (Studio's admin reads); on a legacy `broadcastDelta` frame it is the subscription's registered `table`. No port routes or keys by it.
    ```

5. `packages/do/README.md`, the paragraph beginning "`broadcastDelta` is the raw-delta fan-out for a
   shard like this one". Add two sentences at its end:

    ```text
    A subscription the shard serves by re-execution never receives a broadcast (the shard logs a one-time warning if one matched), so a subclass of a generated shard reaches only table-only subscriptions this way. The broadcast row is the written row: it is not filtered by row-level security, column masks or the subscriber's query, so filter in `matchesSubscription` or do not broadcast data an anonymous socket may not see.
    ```

6. `apps/docs/src/content/docs/concepts/realtime.mdx`, the paragraph beginning "There is also a
   lower-level `delta` frame". Append:

    ```text
    A subscription the shard serves by re-execution never receives one, and the row it carries is not filtered by row-level security or masks.
    ```

Verify:

- `pnpm exec prettier --check protocol/README.md sdks/README.md packages/do/README.md apps/docs/src/content/docs/concepts/realtime.mdx`
  → clean (run without `--check` on these files only, if needed).
- `pnpm exec oxfmt --check` on the touched `.ts` files → clean.
- `pnpm run lint:generated` → exit 0 with no reported paths (`packages/do/README.md` has a generated
  block; do not edit inside it).

### Step 4 — gates

- `pnpm --filter "@lunora/do" run lint:eslint`, `pnpm --filter "@lunora/client" run lint:eslint` → 0.
- `pnpm --filter "@lunora/do" run lint:types` → 0.
- Do NOT run `api:check` (the reviewer does). This plan adds no export; `servedByReexecution` and the
  field are private.

### Step 5 — commit

ONE commit, explicit paths:

```
fix(do): keep broadcast deltas off subscriptions served by re-execution

A shard that re-executes queries and also calls broadcastDelta could feed one subscription from
both paths: the client could not tell the table semantics apart, and a broadcast row bypassed the
re-execution diff and the subscriber's row-level security and masks. broadcastDelta now skips any
subscription the shard serves by re-execution and warns once. Table-only subscriptions still
receive broadcasts.

Behaviour change for hand-written subclasses: a function-path subscription on a shard that
overrides executeSubscription no longer receives broadcastDelta frames.

The protocol README scopes the delta.table rule to re-execution deltas and states the broadcast
path separately; MutationDelta, sdks/README, the @lunora/do README and the realtime guide match.
Follow-up to #1595.
```

plus your Co-Authored-By trailer. Header ≤ 100, body lines ≤ 100.

## 4. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 5. In scope / out of scope

**In scope:** `packages/do/src/shard-do.ts`, `packages/do/__tests__/shard-do.test.ts`,
`packages/do/__tests__/shard-do.socket-reauth.test.ts`, `protocol/README.md`,
`packages/client/src/delta-merge.ts`, `sdks/README.md`, `packages/do/README.md`,
`apps/docs/src/content/docs/concepts/realtime.mdx`.

**Out of scope:** `packages/shard-engine/*`, fixtures, every SDK source or test, `api-snapshots/*`,
`packages/do/docs/*`, and the `matchesSubscription` default logic.

## 6. STOP conditions

- An existing test other than the reauth test in Step 2.3 fails because of the new skip.
- `pnpm run lint:generated` reports a changed path.
- The prototype comparison does not compile, or needs more than one line-scoped disable.

## 7. Open for the owner

Anonymous table-only broadcast subscriptions still receive raw, unfiltered rows. That is the
documented contract (§5.1, "not claim-scoped"). Function-path subscriptions on a shard that does not
re-execute are filtered only by the subclass's `matchesSubscription`. If either should change, it is
a protocol decision (e.g. retiring `broadcastDelta`), not part of this plan.
