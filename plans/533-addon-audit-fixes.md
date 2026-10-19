# Plan 533: Add-on package fixes from the 2026-10-19 audit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2376f8799..HEAD -- packages/mail/src/inbound packages/agent/src/model-messages.ts packages/platform-node/src/node-shard-host.ts packages/flags/src/providers/env.ts packages/container/src/do/native-exec.ts packages/payment/src/reconcile.ts packages/workflow/src/fan-out.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (seven S-sized fixes)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + security
- **Planned at**: commit `2376f8799`, 2026-10-19
- **Issue**: https://github.com/anolilab/lunora/issues/1271
- **Platform parity**: not applicable — no new `ctx.*` surface; the Node host change fixes an existing emulation.

## Why this matters

Seven independent defects at the edges of the add-ons. The worst: an inbound
email with a large attachment OOMs the Worker and bounces mail (anyone who
knows the address can trigger it); an agent thread whose run dies between
persisting a tool call and its result is wedged forever (provider rejects
unpaired tool calls); on the Node host a shard alarm rescheduled while the
previous one fires is lost across restart; `ctx.parallel` never joins on the
Node host. The rest are small correctness gaps.

## Current state

Repo: pnpm monorepo, TypeScript ESM, Vitest. Conventions from `CLAUDE.md`:
relative imports WITHOUT `.js`; named exports only; branch `alpha` — no
backward-compat shims; `eslint --max-warnings=0` (a new `eslint-disable` needs a
`-- reason`). Do not change exported type signatures (that would require an
API-snapshot update); all fixes below are internal.

### A. Inbound mail: attachments are base64'd into the shard RPC without a cap

`packages/mail/src/inbound/parse.ts:265-266` — `PostalMime.parse(raw)` with no
size ceiling. `packages/mail/src/inbound/handler.ts:366-385`:

```ts
const toJsonSafeEmail = (email: InboundEmail): InboundEmail => {
    if (email.attachments.length === 0) {
        return email;
    }

    return {
        ...email,
        attachments: email.attachments.map((attachment) => {
            const { content } = attachment;

            if (typeof content === "string") {
                return attachment;
            }

            const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);

            return { ...attachment, content: toBase64(bytes), encoding: "base64" as const };
        }),
    };
};
```

`handler.ts:406` uses it as the default `resolveArgs`; `:416-429` JSON-encodes
the result and POSTs it to the root shard. Email Routing accepts 25 MB
messages; raw + decoded + base64 + JSON of one 20 MB attachment exceeds the
128 MB isolate limit. The `InboundAttachment` type is at `parse.ts:23`.

### B. Agent: a dangling tool call wedges the thread

`packages/agent/src/model-messages.ts:67-104` — `buildModelMessages` emits an
assistant `tool-call` part for every `row.toolCalls` entry and a `tool-result`
part only for persisted `tool` rows. `packages/agent/src/agent-loop.ts:1314`
persists the assistant row BEFORE executing calls; the failure path at
`:1624-1641` writes no result rows. The next run reads the same history and the
provider rejects the unpaired `tool_call_id` (HTTP 400) at turn 0, forever.

`AgentMessageRow` (`packages/agent/src/types.ts:1136`):

```ts
export interface AgentMessageRow {
    content: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    status?: AgentMessageStatus;
    toolCallId?: string;
    toolCalls?: ReadonlyArray<AgentToolCall>;
    toolName?: string;
}
```

### C. Node shard host: alarm timer deletes a row another write just replaced

`packages/platform-node/src/node-shard-host.ts:193-201`:

```ts
const persist = (timestamp: number | undefined): void => {
    if (timestamp === undefined) {
        database.prepare("DELETE FROM _lunora_alarm WHERE id = 0").run();
    } else {
        database
            .prepare("INSERT INTO _lunora_alarm (id, scheduled_for) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET scheduled_for = excluded.scheduled_for")
            .run(timestamp);
    }
};
```

The timer callback at `:233-256` calls `persist(undefined)` unconditionally.
`set()` at `:321-341` inside a transaction persists the new timestamp but
leaves the old timer armed; when that fires it deletes the freshly written
row; `commit()` (`:344-362`) re-arms in memory only, so a restart loses the
alarm. The test file is `packages/platform-node/__tests__/node-shard-host-alarms.test.ts`.

### D. Flags env provider accepts `Infinity` and non-object JSON

`packages/flags/src/providers/env.ts:113-119`:

```ts
const parsed = Number(value);

if (value.trim() === "" || Number.isNaN(parsed)) {
    return parseError(defaultValue, `env flag "${flagKey}" (${nameOf(flagKey)}) value is not a number`);
}
```

and `:127-129`: `return staticDetails(JSON.parse(value) as T);` — `"null"` and
`"42"` are returned as objects. Test file: `packages/flags/__tests__/env-provider.test.ts`.

### E. Container exec: orphaned `exitCode` rejection on overflow/timeout

`packages/container/src/do/native-exec.ts:47-49`:

```ts
const exitCode = process.exitCode.finally(() => {
    exited = true;
});
```

`:112-118` return on `overflowed`/`timedOut` after `stop()` killed the process
and before `await exitCode` (`:128`). `packages/container/src/do/spawn.ts:146-154`
adds `exit.catch(() => undefined)` for exactly this reason.

### F. Payment reconcile: unbounded fan-out and a stale-write window

`packages/payment/src/reconcile.ts:138-152`:

```ts
const reconcileSubscription = async (adapter: PaymentAdapter, store: PaymentStore, id: string, observer?: PaymentObserver): Promise<boolean> => {
    const current = await adapter.getSubscriptionStatus(id);
    const existing = await store.getSubscription(adapter.identifier, id);

    if (!subscriptionDrifted(existing, current)) {
        return false;
    }

    await store.upsertSubscription(overlayProviderSubscription(existing, current));
```

and `:263`: `const settled = await Promise.allSettled(ids.map((id) => reconcileOne(id)));`
— one provider call per id, all at once. Test file: `packages/payment/__tests__/reconcile.test.ts`.

### G. Workflow `ctx.parallel`: a freshly created child that already finished is never joined

`packages/workflow/src/fan-out.ts:519-539`:

```ts
                    const { attached, instance } = await createOrAttach(binding, { ... });

                    if (!attached) {
                        return undefined;
                    }
                    ...
                    const outcome = await attachedOutcome(instance);

                    return outcome === undefined ? undefined : boundOutcome(outcome);
```

`attachedOutcome` (`:330-342`) returns a bounded outcome when
`instance.status()` is terminal, else `undefined`. On `@lunora/platform-node`,
`create()` runs the child to completion synchronously
(`node-workflow-host.ts:801` awaits `runtime.trigger`), and `sendEvent`
(`:692-696`) throws unless the run is already waiting, so the parent's
`waitForEvent` never resolves. Calling `attachedOutcome` on the fresh-create
path too makes the join skip the event when the child is already terminal.
Test file: `packages/platform-node/__tests__/node-workflow-host.test.ts`
(has a `ctx.spawn` case at `:513-540` to model on).

## Commands you will need

| Purpose    | Command                                                                                                                                                                                                                              | Expected |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Install    | `pnpm install --frozen-lockfile`                                                                                                                                                                                                     | exit 0   |
| Build deps | `pnpm --filter "@lunora/mail..." --filter "@lunora/agent..." --filter "@lunora/platform-node..." --filter "@lunora/flags..." --filter "@lunora/container..." --filter "@lunora/payment..." --filter "@lunora/workflow..." run build` | exit 0   |
| Test       | `pnpm --filter "@lunora/<pkg>" run test`                                                                                                                                                                                             | all pass |
| Typecheck  | `pnpm --filter "@lunora/<pkg>" run lint:types`                                                                                                                                                                                       | exit 0   |
| Lint       | `pnpm --filter "@lunora/<pkg>" run lint:eslint`                                                                                                                                                                                      | exit 0   |
| API        | `pnpm run api:check`                                                                                                                                                                                                                 | exit 0   |

## Scope

**In scope**:

- `packages/mail/src/inbound/handler.ts`, `packages/mail/__tests__/inbound-handler.test.ts`
- `packages/agent/src/model-messages.ts`, `packages/agent/__tests__/model-messages.test.ts`
- `packages/platform-node/src/node-shard-host.ts`, `packages/platform-node/__tests__/node-shard-host-alarms.test.ts`
- `packages/flags/src/providers/env.ts`, `packages/flags/__tests__/env-provider.test.ts`
- `packages/container/src/do/native-exec.ts` (+ its test if one exists: `ls packages/container/__tests__ | grep -i exec`)
- `packages/payment/src/reconcile.ts`, `packages/payment/__tests__/reconcile.test.ts`
- `packages/workflow/src/fan-out.ts`, `packages/platform-node/__tests__/node-workflow-host.test.ts`

**Out of scope**:

- `packages/agent/src/agent-loop.ts`, `component.ts` — the prompt-assembly fix is sufficient; do not change persistence.
- `packages/platform-node/src/node-scheduler-host.ts`, `node-workflow-host.ts` — multi-process claims are a separate design item.
- Any exported type or `api-snapshots/*`.

## Git workflow

- Branch: `fix/addons-audit-2026-10-19` from `alpha`.
- One conventional commit per step; scope = package, e.g. `fix(mail): cap inbound attachment bytes forwarded to the shard`.
- Do NOT push or open a PR.

## Steps

### Step 1: Cap forwarded attachment bytes (mail)

In `handler.ts` add `const MAX_FORWARDED_ATTACHMENT_BYTES = 4 * 1024 * 1024;`
(doc: total binary attachment bytes forwarded in the default envelope; apps
needing more supply `resolveArgs` and store to R2). In `toJsonSafeEmail`, keep a
running total; once an attachment's `byteLength` would exceed the budget, emit
`{ ...attachment, content: "", encoding: "base64", truncated: true }` instead
of the base64 string. Add `truncated?: boolean` (documented: "binary content
dropped because the forwarded envelope exceeded the attachment byte budget")
to the `InboundAttachment` interface at `parse.ts:23`. That interface is part
of the public type surface, so after `pnpm --filter "@lunora/mail" run build`
run `pnpm run api:check`; if it reports ONLY the new optional field in
`api-snapshots/mail.api.md`, run `pnpm run api:update` and commit that
snapshot with this step. Any other snapshot diff is a STOP. Add
`api-snapshots/mail.api.md` to your in-scope list for this step only.

Test: in `inbound-handler.test.ts`, dispatch an email with one 5 MB
`Uint8Array` attachment and assert the posted envelope's attachment has
`content === ""` and `truncated === true`, and that a 1 KB attachment is
forwarded base64 intact.

**Verify**: `pnpm --filter "@lunora/mail" run test` → all pass.

### Step 2: Pair dangling tool calls (agent)

In `model-messages.ts` `buildModelMessages`: before the loop, build
`const answered = new Set(options.history.filter((row) => row.role === "tool" && row.toolCallId !== undefined).map((row) => row.toolCallId))`.
In the `assistant` case, after pushing the assistant message, for each
`call` in `row.toolCalls ?? []` whose `call.id` is not in `answered`, push a
synthetic tool message:

```ts
{ content: [{ output: { type: "text", value: "Tool call was not executed: the run was interrupted before it ran." }, toolCallId: call.id, toolName: call.name, type: "tool-result" }], role: "tool" }
```

Reuse `toolMessage` by constructing a row-shaped object, or add a small
`unexecutedToolMessage(call)` helper — named, not default-exported.

Test in `model-messages.test.ts`: history = user, assistant with two tool
calls, one `tool` row answering the first. Assert output contains exactly two
`tool` messages, the second with the synthetic text and the second call's id,
in that order right after the assistant message.

**Verify**: `pnpm --filter "@lunora/agent" run test -- model-messages` → all pass.

### Step 3: Conditional alarm consume (platform-node)

In `node-shard-host.ts`: give `persist` a sibling
`const consume = (firedAt: number): void => { database.prepare("DELETE FROM _lunora_alarm WHERE id = 0 AND scheduled_for = ?").run(firedAt); };`
In the timer callback (`:233-256`), capture the timestamp the timer was armed
for (the `arm(ms)` argument — thread it through the closure) and call
`consume(firedAt)` instead of `persist(undefined)`.

Test in `node-shard-host-alarms.test.ts` (model on an existing case there):
arm alarm at T1; inside a transaction set alarm T2 (> T1) and commit after T1
has fired (use fake timers); assert `SELECT scheduled_for FROM _lunora_alarm`
still returns T2 and that re-creating the host over the same database re-arms T2.

**Verify**: `pnpm --filter "@lunora/platform-node" run test -- node-shard-host-alarms` → all pass.

### Step 4: Flags env provider validation

`Number.isNaN(parsed)` → `!Number.isFinite(parsed)`. For objects: after
`JSON.parse`, if `typeof parsed !== "object" || parsed === null` return
`parseError(defaultValue, \`env flag "${flagKey}" (${nameOf(flagKey)}) is not a JSON object\`)`.
Tests: `"Infinity"`→`PARSE_ERROR`with default;`"null"`and`"42"`→`PARSE_ERROR`; `'{"a":1}'`and`'[1]'` still resolve.

**Verify**: `pnpm --filter "@lunora/flags" run test -- env-provider` → all pass.

### Step 5: Swallow the orphaned exit rejection (container)

After the `exitCode` declaration at `native-exec.ts:49` add
`exitCode.catch(() => undefined);` with a one-line comment pointing at
`spawn.ts`'s identical guard. The success path's `await exitCode` still throws.

**Verify**: `pnpm --filter "@lunora/container" run test && pnpm --filter "@lunora/container" run lint:eslint` → exit 0.

### Step 6: Bound the reconcile sweep and skip stale writes (payment)

In `reconcile.ts`:

1. Replace `Promise.allSettled(ids.map(...))` in `sweep` with a worker-pool of
   8 (a simple index-cursor loop over 8 `async` workers that each `await
reconcileOne(id)` and push `{ status, value|reason }` into a result array by
   index) so the result shape used below stays identical.
2. In `reconcileSubscription`, after `subscriptionDrifted` and before the
   upsert, re-read `store.getSubscription(adapter.identifier, id)`; if its
   `lastEventAt` (or `updatedAt`, whichever the store row carries — check
   `packages/payment/src/store.ts:127-134`) differs from `existing`'s, return
   `false` without writing (a webhook landed mid-sweep and is newer than the
   provider snapshot). Apply the same guard in `reconcilePayment` if it has the
   same shape.

Tests in `reconcile.test.ts`: (a) 20 ids with an adapter that records peak
concurrent in-flight calls → assert ≤ 8; (b) a store whose second
`getSubscription` returns a row with a newer `lastEventAt` → assert no upsert.

**Verify**: `pnpm --filter "@lunora/payment" run test -- reconcile` → all pass.

### Step 7: Join already-terminal fresh children (workflow)

In `fan-out.ts:519-539` remove the early `return undefined` for `!attached`
and call `attachedOutcome(instance)` on both paths (keep the bounded-output
comment). Add a Node-host test next to the `ctx.spawn` case in
`node-workflow-host.test.ts`: a parent with `ctx.parallel` over two branches
that return immediately → assert the parent completes with the output tuple;
a second case where one branch throws → the parent reports the branch error.

**Verify**: `pnpm --filter "@lunora/workflow" run test && pnpm --filter "@lunora/platform-node" run test -- node-workflow-host` → all pass.

## Done criteria

- [ ] `run test`, `run lint:types`, `run lint:eslint` exit 0 for mail, agent, platform-node, flags, container, payment, workflow
- [ ] `pnpm run api:check` exits 0 (after `pnpm --filter "@lunora/mail" run build` if Step 1 touched the snapshot)
- [ ] `git status` shows no files outside scope
- [ ] Each step has its new test(s) present and passing

## STOP conditions

- Drift: excerpts do not match the live code.
- Step 1: `InboundAttachment`/`InboundEmail` shape cannot take an optional field without a breaking snapshot diff.
- Step 7: the Node-host `ctx.parallel` test still hangs after the fan-out change — report the observed state; do not patch `node-workflow-host.ts`.
- A verification fails twice.

## Maintenance notes

- The agent fix pairs calls at prompt-assembly time; if persistence later writes result rows for interrupted calls, the synthetic branch becomes dead code and should be removed.
- The reconcile concurrency constant (8) is a guess under Stripe's rate limit; make it an option only when a second provider needs a different value.
