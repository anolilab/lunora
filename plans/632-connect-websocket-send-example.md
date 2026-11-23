# Plan 632: The `connectWebSocket` example no longer sends before the socket is open

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/client/src/lunora-client.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `docs/client-websocket-send-example`; PR #1650

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

The doc comment of `LunoraClient.connectWebSocket` says a `send` while the socket is not open is dropped. Its own example calls `chat.send({ text: "hello" })` on the line after `connectWebSocket(...)`, when the socket cannot be open yet — so the documented first message is silently lost. Dropping is the documented design ("the channel is transient, like a whisper"); the example is what is wrong.

## Current state

`packages/client/src/lunora-client.ts` (~lines 2440-2462):

```ts
     * const chat = client.connectWebSocket<{ text: string }>("/chat", {
     *     onMessage: (message) => append(message.text),
     * });
     * chat.send({ text: "hello" });
     * chat.close();
```

and further down: "Returns a handle with `send` and `close`; a `send` while the socket is not open is dropped (the channel is transient, like a whisper)." The handler bag accepts `onOpen?: () => void`.

## Design (decided)

Docs only. Rewrite the example so the first `send` happens in `onOpen` (declare `chat` first, send from the callback), and add one sentence right after the example: send from `onOpen` (or later) — an earlier `send` is dropped. Apply the same correction to every other copy of the pattern: `rg -n "connectWebSocket" apps/docs packages/*/docs packages/*/README.md templates examples registry --glob '!**/node_modules/**' | head -40` and the framework adapters' doc comments (`rg -n "connectWebSocket" packages/*/src --glob '!packages/client/**' | head`). Change **no** runtime code.

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

## Steps

1. Edit the doc comment and each other copy found. **Verify**: `pnpm --filter "@lunora/client..." run build && pnpm --filter "@lunora/client" run lint:eslint && pnpm --filter "@lunora/client" run lint:types` exit 0; `git diff --stat` shows only comments/markdown changed.
2. If you edited `.md`/`.mdx`, run `pnpm exec prettier --check <those files>`.

## Scope

**In scope**: doc comments and markdown that show a `send` straight after `connectWebSocket`. **Out of scope**: queueing sends before open (a behaviour change — not wanted here); `api-snapshots/`.

## Git workflow

- Branch: `docs/client-websocket-send-example`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `docs(client): send from onOpen in the websocket example`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] No example sends before open: `rg -n -A6 "connectWebSocket<" packages/client/src/lunora-client.ts` shows the send inside `onOpen`
- [ ] Lint and types for `@lunora/client` exit 0

## STOP conditions

- An example app actually relies on a pre-open `send` being delivered (runtime code, not docs): report it; do not change runtime code.
