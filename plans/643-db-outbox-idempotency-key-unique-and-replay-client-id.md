# Plan 643: An outbox write has a key no other write can reuse, and its replay runs under the client id it was made with

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/client/src/lunora-client.ts packages/db/src/define-collections.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/db` gives the client a durable outbox built on `@tanstack/offline-transactions` (pinned in `pnpm-workspace.yaml`; read the installed version in `node_modules` when the plan refers to its behaviour — it is read-only). The client hands a write to the outbox "sink" (`packages/db/src/internals.ts` ~283-301, `enqueue`), and the outbox replays it later through `packages/db/src/define-collections.ts` (~495-600), which calls `client.mutation(..., { mutationId, replayBaseline, replayCredential, shardKey })`.

Two defects in how such a write is identified:

1. The idempotency key is `<clientId>:<counter>`, and the counter restarts at 0 for every client instance:

```ts
        if (this.outbox) {
            this.outboxMutationCounter += 1;
            const outboxMutationId = this.outboxMutationCounter;

            try {
                await this.outbox.enqueue({
                    args: argsRecord,
                    // The view the caller composed against, handed over so the sink
                    // can replay it verbatim — see `OutboxMutation.baselineSeq`.
                    baselineSeq,
                    clientId: this.clientId,
                    functionPath: function_.__lunoraRef,
                    // The caller's own `mutationId` when it passed one (an
                    // `importRows` chunk): its replay must dedup against the key a
                    // resumed run sends again, not a per-session counter.
                    idempotencyKey: callerMutationId ?? `${this.clientId}:${String(outboxMutationId)}`,
                    identity: issuingIdentity,
                    mutationId: outboxMutationId,
                    // The only signal that can take this write's predicted value
```

`packages/client/src/types.ts` (~443-452) tells `@lunora/db` apps to pass a **stable** `clientId`. With one, `<id>:1` comes back after every reload and in every tab. The server dedups on `(identity, mutationId)` for 24 h, so a new write is answered from an old write's cached result and never runs — and the replay handler counts it as committed.

2. With the default per-session `clientId`, the replay does not send the persisted `meta.clientId`:

```ts
const send = async (replayCredential: ReplayCredential): Promise<unknown> =>
    client.mutation({ __lunoraRef: meta.functionPath }, meta.args, {
        mutationId: meta.idempotencyKey,
        // Pinned, never re-sampled — see `WriteProvenance.baselineSeq`.
        // eslint-disable-next-line unicorn/no-null -- `null` is the documented "pin no baseline" sentinel; `undefined` means "sample now"
        replayBaseline: meta.baselineSeq ?? null,
        // Sent with the bearer the verdict above judged; under a cookie
        // session the worker also refuses the write if the cookie now
        // belongs to someone else.
        replayCredential,
        shardKey: meta.shardKey,
    });
```

so `rpc` stamps the _live_ id. An anonymous caller's dedup namespace is its client id, so a write that committed before a reload but was never acknowledged runs again after it. The built-in `OfflineQueue` was already fixed for exactly this (`item.clientId ?? this.clientId`, `rg -n "item.clientId" packages/client/src/lunora-client.ts`).

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                           | Expected on success |
| ----------------------------- | ----------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                  | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/client..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/client" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/client" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/client" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/client" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

1. Make the generated key unique per write regardless of client id reuse: `<clientId>:<random>` using the same id generator the client already uses for mutation ids (`rg -n "nextId|crypto.randomUUID" packages/client/src/offline-queue.ts packages/client/src/lunora-client.ts | head`). A caller-supplied `mutationId` still wins, unchanged. Keep `mutationId: outboxMutationId` (the numeric field) as is if other code orders by it.
2. Carry the persisted client id through the replay: add the option the built-in queue's replay uses (find how `item.clientId` reaches `rpc`) to the `client.mutation` options the db replay passes, set from `meta.clientId`. If that option is internal-only today, expose it the same way `replayBaseline`/`replayCredential` are exposed (they are the precedent).

## Steps

1. Tests first. In `packages/client/__tests__`: two client instances created with the same `clientId` each enqueue one outbox write → the two `idempotencyKey`s differ. In `packages/db/__tests__` (see `outbox-replay.test.ts` for the harness): a persisted outbox entry with `clientId: "old"` replayed by a client whose id is `"new"` sends the RPC under `"old"`. Red at baseline.
2. Implement. 3. `api-snapshots/client.api.md`: if a public option is added, update that snapshot by hand and say so. 4. Build, test, types, eslint for `@lunora/client` and `@lunora/db`.

## Git workflow

- Branch: `fix/db-outbox-replay-integrity`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(client): give each outbox write a key of its own`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Something parses the `<clientId>:<counter>` key format (`rg -n "idempotencyKey" packages --glob '!**/__tests__/**' | head -40`): STOP and report the consumer.
