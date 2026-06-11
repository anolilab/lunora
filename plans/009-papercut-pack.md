# Plan 009: Papercut pack — eight small confirmed fixes across six packages

> **Executor instructions**: Follow this plan step by step. Each item is
> independent: fix, verify, commit, move on. If an item hits its STOP
> condition, skip it, note it in your report, and continue with the next item
> — do not let one item block the pack. When done, update the status row in
> `plans/README.md` (note any skipped items there).
>
> **Drift check (run first)**: `git diff --stat 2f6a466f..HEAD -- packages/do/src/shard-do.ts packages/db/src/internals.ts packages/react/src/use-query.ts packages/storage/src/create-storage.ts packages/auth/src/admin.ts packages/cli/src/util/studio-server.ts packages/cli/src/commands/init/index.ts packages/config/src/wrangler-validator.ts`
> For any file that changed, re-read the cited lines before editing it; on a
> mismatch with the excerpt, treat that ITEM (not the whole plan) as stopped.

## Status

- **Priority**: P2
- **Effort**: S (per item; ~a day for the pack with tests)
- **Risk**: LOW
- **Depends on**: 006 should land first or be coordinated — item 1 edits
  `packages/do/src/shard-do.ts`, same file as plan 006 (different method;
  rebase, don't fork).
- **Category**: bug / dx / security hardening
- **Planned at**: commit `2f6a466f`, 2026-06-11

## Why this matters

Eight independently-verified small defects: two latent bugs, three security
hardening gaps, three error-message/help-text papercuts. None justifies a
plan alone; together they remove a class of "death by a thousand cuts"
friction. Every item was confirmed against the code at `2f6a466f`.

## Commands you will need

| Purpose   | Command                                              | Expected |
| --------- | ----------------------------------------------------- | -------- |
| Install   | `pnpm install`                                        | exit 0   |
| Per-pkg test | `pnpm --filter "@cirrus/<pkg>" run test`           | all pass |
| Per-pkg types | `pnpm --filter "@cirrus/<pkg>" run lint:types`    | exit 0   |
| Per-pkg lint | `pnpm --filter "@cirrus/<pkg>" run lint:eslint`    | exit 0   |

Run the three gates for each package you touch, after each item.

## Git workflow

- Branch: `fix/papercut-pack-2026-06` off `alpha` (rebase onto plan 006's
  branch if it exists and is unmerged).
- One conventional commit per item (scope = package), e.g.
  `fix(do): roll back unsubscribe when attachment serialization fails`.
- Do NOT push or open a PR unless the operator instructed it.

## Items

### Item 1 — `@cirrus/do`: unsubscribe lacks the serialize-failure rollback subscribe has

`packages/do/src/shard-do.ts:1901-1908`:

```ts
protected unsubscribe(ws: WebSocket, subId: string): void {
    const attachment = this.readAttachment(ws);
    delete attachment.subs[subId];
    (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
    this.subMemos.get(ws)?.delete(subId);
}
```

`subscribe()` directly above (lines 1876–1899) wraps `serializeAttachment` in
try/catch with rollback, and its doc comment states the invariant: "We never
throw out of this path — the WS hibernation API treats a thrown
`webSocketMessage` as a fatal-channel error." `unsubscribe` violates it: a
throwing `serializeAttachment` propagates out. Fix: mirror subscribe's
pattern — on throw, restore `attachment.subs[subId] = <the deleted query>`
(capture it before deleting) and return without touching the memo; on
success, delete the memo as today. Keep `void` return (callers don't branch).
Add a test next to the existing subscribe/unsubscribe tests in
`packages/do/__tests__/` (find them: `grep -rln "unsubscribe" packages/do/__tests__ | head -3`)
with a `serializeAttachment` stub that throws: assert no throw escapes and
the subscription is still present (rollback).

**Verify**: `@cirrus/do` gates pass. **STOP-item if**: the method body differs
from the excerpt.

### Item 2 — `@cirrus/db`: online-detector `subscribe` overwrites the shared interval

`packages/db/src/internals.ts:106-126` (`createOptimisticOnlineDetector`):
`subscribe` assigns `interval = setInterval(...)` to the single closure
variable. A second `subscribe` call leaks the first interval (never cleared)
and the first caller's unsubscribe then clears the *second* caller's timer.
Fix: track intervals per subscription —

```ts
const intervals = new Set<ReturnType<typeof setInterval>>();
subscribe: (callback) => {
    const handle = setInterval(callback, OUTBOX_DRAIN_INTERVAL_MS);
    intervals.add(handle);
    return () => { clearInterval(handle); intervals.delete(handle); };
},
dispose: () => { for (const handle of intervals) clearInterval(handle); intervals.clear(); },
```

Add a test in `packages/db/__tests__/` (vi.useFakeTimers): two subscribes,
unsubscribe the first, advance timers, assert the second callback still
fires and the first doesn't; `dispose()` stops both.

**Verify**: `@cirrus/db` gates pass.

### Item 3 — `@cirrus/react`: `useQuery` keys deps on `JSON.stringify`, sibling hooks use `stableStringify`

`packages/react/src/use-query.ts:33`:

```ts
const queryKey = useMemo(() => cirrusQueryKey(function_, argsRecord, shardKey), [function_.__cirrusRef, JSON.stringify(argsRecord), shardKey]);
```

`use-subscription.ts:24` uses `stableStringify` from `./query-key` for the
same job. `JSON.stringify` is key-order-sensitive, so `{a,b}` vs `{b,a}`
needlessly recomputes the memo and re-runs the effect. Fix: import
`stableStringify` from `./query-key` and use it in that dep array (check the
file for other `JSON.stringify(argsRecord)` deps and convert those too).
Behavior-preserving; existing tests must stay green. Add one test only if
`packages/react/__tests__` already has a use-query rerender harness that
makes it cheap (model on an existing case); otherwise skip the new test and
say so.

**Verify**: `@cirrus/react` gates pass.

### Item 4 — `@cirrus/storage`: `allowedContentTypes: []` silently disables the allowlist

`packages/storage/src/create-storage.ts:211` — the comment says the allowlist
"is a security control (e.g. block `text/html` to prevent stored-XSS)", but
the guard is:

```ts
if (uploadOptions.allowedContentTypes && uploadOptions.allowedContentTypes.length > 0) {
```

so a dynamically-computed list that ends up `[]` means "permit anything",
the opposite of an allowlist's natural deny-all reading. Fix: change the
condition to `!== undefined`; an empty configured list then (a) still
requires `contentType` and (b) rejects every value via the `includes` check
— i.e. `[]` = deny all, `undefined` = unrestricted. Update/add tests in
`packages/storage/__tests__/` covering `[]` (rejects with the existing error
messages) and `undefined` (unrestricted, unchanged).

**Verify**: `@cirrus/storage` gates pass.

### Item 5 — `@cirrus/auth`: impersonation TTL is hard-coded at 1 hour

`packages/auth/src/admin.ts:233`: `const DEFAULT_IMPERSONATION_SECONDS = 3600;`
used when minting the impersonation session (~line 435–439, the
`{ expiresAt, impersonatedBy: options.impersonatedBy ?? userId }` call).
There is no override (verified: no `impersonation*` option exists in the
file). Fix: add an optional `impersonationSeconds?: number` to the
options/parameters type that `impersonateUser` already receives (read the
surrounding method signature for the right type to extend), validated the
way the file validates other numeric inputs (see `MAX_BAN_SECONDS` at line
235 for the local pattern — clamp/reject absurd values; require a positive
finite integer, cap at `DEFAULT_IMPERSONATION_SECONDS * 24`). Default stays
3600. Add a test asserting a custom TTL shifts `expiresAt` accordingly and
an invalid TTL (0, negative, `Infinity`) is rejected.

**Verify**: `@cirrus/auth` gates pass.

### Item 6 — `@cirrus/cli`: `EADDRINUSE` on the studio port surfaces a raw syscall error

`packages/cli/src/util/studio-server.ts:182-186`:

```ts
await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => { resolve(); });
});
```

The raw rejection reaches `packages/cli/src/commands/dev/handler.ts:272` and
prints `studio server failed to start (listen EADDRINUSE ...) — continuing
without it`. Fix in `studio-server.ts`: wrap the rejection — when
`(error as NodeJS.ErrnoException).code === "EADDRINUSE"`, reject with
`new Error(\`port ${options.port} is already in use — pass a different studio port or stop the other process\`, { cause: error })`
(check how the dev command names its studio-port flag with
`grep -n "studio" packages/cli/src/commands/dev/index.ts` and name the actual
flag in the message); other errors pass through unchanged. Add a unit test in
`packages/cli/__tests__/` next to any existing studio-server test (find:
`ls packages/cli/__tests__ | grep -i studio`): bind a throwaway server to a
port, start a second on the same port, assert the message names the port and
the flag.

**Verify**: `@cirrus/cli` gates pass.

### Item 7 — `@cirrus/cli`: init help text offers a template the handler rejects

`packages/cli/src/commands/init/index.ts:21`:

```ts
description: "Template to scaffold (vite | standalone | tanstack-start | next)",
```

but `handler.ts:522-526` warns and exits 1 for `next` ("not yet available").
Fix the description to `"Template to scaffold (vite | standalone | tanstack-start)"`.
Leave the handler's guard intact (it's a good failure mode for old scripts).
Update any test asserting the old description string
(`grep -rn "tanstack-start | next" packages/cli` to find them).

**Verify**: `@cirrus/cli` gates pass.

### Item 8 — `@cirrus/config`: wrangler validator errors state the problem but not the remedy

`packages/config/src/wrangler-validator.ts:145-146` and `:171-173`:

```ts
errors.push('durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" }');
...
errors.push('schema declares .global() tables; d1_databases must include a binding named "DB"');
```

Append the remediation to each of these two messages (only these two — the
compatibility_date messages already say what to write):
`' — run `cirrus dev` to auto-reconcile wrangler.jsonc, or add the binding manually'`.
Update the tests that assert these exact strings
(`grep -rn "must include" packages/config/__tests__` to find them).

**Verify**: `@cirrus/config` gates pass.

## Scope

**In scope**: exactly the files named per item plus their test files.
**Out of scope**: everything else — in particular `refreshSubscriptions`
(plan 006), any public API shape beyond item 5's additive option, and the
templates directory.

## Done criteria

- [ ] Each completed item's package passes `test`, `lint:types`, `lint:eslint`
- [ ] One commit per completed item, conventional format
- [ ] Skipped items (if any) listed with their STOP reason in the report and in `plans/README.md`
- [ ] `git status` clean apart from in-scope files
- [ ] Full monorepo gate at the end: `pnpm run test:affected` exits 0

## STOP conditions

Per item (skip the item, continue the pack):
- The excerpt doesn't match the live code.
- The fix breaks >3 existing tests in ways the item text didn't predict.
- Item 5: if `impersonateUser`'s options already flow from a public type that
  other packages re-export, confirm the addition is purely additive before
  editing; if not, skip.

Whole plan: more than 4 items stopped — report back, the tree has drifted.

## Maintenance notes

- Item 4 is a behavior change for anyone who (pointlessly) passed `[]`
  expecting "unrestricted" — call it out in the commit body as the intended
  semantic fix.
- Item 1 and plan 006 both edit `shard-do.ts`; whichever lands second rebases.
- Items 6–8 change user-facing strings; release notes pick them up via the
  conventional commits automatically.
