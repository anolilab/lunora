# Plan 627: Inbound mail dispatch wire-encodes its args so message content cannot forge a typed wire value

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/mail/src/inbound/shard.ts packages/mail/src/inbound/handler.ts packages/mail/src/from-env.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Every RPC argument that reaches a shard is decoded with the wire codec, which turns a tagged array of the form `["$lunora.wire$", "<kind>", "<value>"]` (tag constant `TAG` in `packages/wire/src/wire-codec.ts:69`) back into a typed value (`bigint`, `Date`, bytes, …). Callers are expected to **encode** their args first; encoding also escapes user data that merely looks like a tag. The inbound mail dispatcher posts the parsed email as plain `JSON.stringify`, without encoding. Email content is attacker-controlled: an address list, header value or JSON-ish field that parses into an array shaped like a wire tag is decoded on the shard as a typed value, so the target function receives a `bigint`/`Date`/bytes where its validator and code expect the sender's string — a validation failure at best, a type confusion at worst.

## Current state

`packages/mail/src/inbound/shard.ts` `postShardRpc` (~line 103): `body: JSON.stringify(options.envelope)`, sent to `https://shard.internal/rpc` with the `x-lunora-system: 1` header.

`packages/mail/src/inbound/handler.ts` `dispatchToLunoraFunction` (~line 475-507) builds the envelope:

```ts
const envelope: RpcEnvelope = {
    args: resolveArgs(email, context),
    functionPath: options.functionPath,
    shardKey,
};
```

where `resolveArgs` defaults to `toJsonSafeEmail(email)` (base64-encodes binary attachments, nothing else). `packages/mail/src/from-env.ts` (~line 161) uses the same helper for the outbound dev capture sink: `envelope: { args: mail, functionPath: RECORD_MAIL_OP }`.

Other server-side callers of the same shard RPC do encode: see `packages/scheduler/src/create-scheduler.ts` and `packages/runtime/src/shard-client.ts` (`rg -n "encodeWire|wireEncode|toWire" packages/scheduler/src packages/runtime/src/shard-client.ts`) — use whichever function they use, imported the way they import it.

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

| Purpose                       | Command                                                         | Expected on success |
| ----------------------------- | --------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/mail..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/mail" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/mail" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/mail" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/mail" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

Encode `envelope.args` with the wire codec inside `postShardRpc` — the single owner of this path — so both callers are covered and cannot drift. `functionPath` and `shardKey` stay plain. Type the option as `{ args: unknown; functionPath: string; shardKey?: string }` instead of `unknown` so the helper can reach `args`.

## Steps

1. Confirm the premise in code: find where the shard's `/rpc` decodes `args` (`rg -n "decodeWire|fromWire" packages/do/src/shard-do.ts`) and confirm the encoder escapes a user array that starts with the tag string (read the encoder in `packages/wire/src/wire-codec.ts` and its tests). Write both file:line facts in your report.
2. Check `@lunora/mail`'s `package.json`: is `@lunora/wire` already a dependency? If not, add it the way sibling packages reference workspace deps, then run `pnpm install` and `pnpm run lint:package-json`.
3. Test first, in the existing inbound dispatch test file (`rg -ln "postShardRpc|dispatchToLunoraFunction" packages/mail/__tests__`): dispatch an email whose `to` (or a header value) contains the literal array `["$lunora.wire$","bigint","1"]` (use the real tag constant via the codec's export if there is one). Capture the body the stub received, decode it with the wire decoder, and assert the decoded args deep-equal the original email args (the array is still an array of three strings). Add the same assertion for the `from-env.ts` capture path if it has a test. **Verify**: fails at baseline.
4. Implement. **Verify**: new tests pass; existing tests that asserted the raw JSON body are updated to decode first (list them).
5. Build, test, types, eslint for `@lunora/mail`.

## Scope

**In scope**: `packages/mail/src/inbound/shard.ts`, its two callers only as far as types require, `packages/mail/package.json` (dependency), tests in `packages/mail/__tests__/`.

**Out of scope**: `toJsonSafeEmail`; the wire codec itself; the shard's decode side; any other package.

## Git workflow

- Branch: `security/mail-inbound-wire-args`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(mail): wire-encode args on the shard rpc path`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] New test passes and was seen red without the fix
- [ ] `pnpm --filter "@lunora/mail" run test`, `lint:types`, `lint:eslint` exit 0; `pnpm run lint:package-json` exits 0 if a manifest changed

## STOP conditions

- The shard does **not** wire-decode `args` on the `x-lunora-system` path: the finding is void — report NOT REPRODUCED, commit nothing.
- The encoder does not escape tag-shaped user arrays: encoding alone would not close the hole — STOP and report (that is then a `@lunora/wire` finding).
- `@lunora/mail` must stay free of a `@lunora/wire` dependency by a recorded decision (check its README/package docs): STOP and report.

## Maintenance notes

- Base64 attachment content is a string and passes through the codec unchanged; binary could now be sent as wire bytes instead, but that is a separate change.
