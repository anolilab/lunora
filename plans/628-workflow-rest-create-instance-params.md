# Plan 628: The Workflows REST client sends `params` as a JSON value, not a JSON string

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/workflow/src/rest-api.ts packages/workflow/__tests__/rest-api.test.ts`
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
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`createInstance` in the Cloudflare Workflows REST client stringifies `params` and then stringifies the whole body again, so the API receives `"params": "{\"sku\":\"a\"}"` — a string. An instance started this way (Studio's "start instance" goes through this client) gets a string as `event.payload` where the workflow code expects the object. A unit test pins the double encoding. **The API contract was inferred, not checked**: step 1 checks it against Cloudflare's reference before anything changes.

## Current state

`packages/workflow/src/rest-api.ts` (~lines 269-279):

```ts
        createInstance: async ({ instanceId, params, workflowName }) => {
            // A forged marker here would reach the child's event.payload and spoof a ctx.parallel completion.
            if (hasBranchMarker(params)) {
                throw new LunoraError("BAD_REQUEST", `@lunora/workflow: params ${BRANCH_MARKER_REJECTION}`, { status: 400 });
            }

            const payload = {
                ...(instanceId === undefined ? {} : { instance_id: instanceId }),
                ...(params === undefined ? {} : { params: JSON.stringify(params) }),
            };
            const body = await request(`/${encodeURIComponent(workflowName)}/instances`, { body: JSON.stringify(payload), method: "POST" });
```

Doc comment at ~line 172: "Start a new instance. `params` is sent JSON-encoded, as the instance's event payload."

`packages/workflow/__tests__/rest-api.test.ts:246`:

```ts
expect(calls[0]?.init?.body).toBe(JSON.stringify({ instance_id: "order-1", params: JSON.stringify({ sku: "a" }) }));
```

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

| Purpose                       | Command                                                                       | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                              | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/workflow..." run build`                               | exit 0              |
| One test file                 | `pnpm --filter "@lunora/workflow" exec vitest run __tests__/rest-api.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/workflow" run test`                                   | all pass            |
| Types                         | `pnpm --filter "@lunora/workflow" run lint:types`                             | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/workflow" run lint:eslint`                            | exit 0, 0 warnings  |

## Steps

1. **Establish the contract.** Read Cloudflare's API reference for "Workflows → Instances → Create a new workflow instance" (`https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/create/`) and record the documented type of the `params` body field. Cross-check with wrangler's own client in `node_modules` (`rg -n "instance_id" node_modules/.pnpm/wrangler*/node_modules/wrangler/wrangler-dist/cli.js | head`) — how does `wrangler workflows trigger` build the body? Quote both in your report.
2. If the documented type is an arbitrary JSON value/object: change the payload to `{ params }` (no inner `JSON.stringify`), fix the doc comment at ~line 172, and update the test at line 246 to expect `JSON.stringify({ instance_id: "order-1", params: { sku: "a" } })`. Add a case with a non-object param (a number or array) and one with `params` omitted.
3. Check the callers still pass a value, not a pre-stringified string: `rg -n "createInstance\(" packages apps --glob '!**/__tests__/**'`. If a caller stringifies before calling, remove that too.
4. Red check, then build, test, types, eslint for `@lunora/workflow`.

## Scope

**In scope**: `packages/workflow/src/rest-api.ts`, its test, direct callers found in step 3. **Out of scope**: `sendEvent` and the other endpoints; the branch-marker check (keep it, it runs on the unencoded value).

## Git workflow

- Branch: `fix/workflow-rest-params`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(workflow): send instance params as a json value`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] Report quotes the API reference and wrangler's body construction
- [ ] `pnpm --filter "@lunora/workflow" run test`, `lint:types`, `lint:eslint` exit 0

## STOP conditions

- The reference documents `params` as a **string**, or wrangler itself sends a JSON string: the current code is right — report NOT A BUG, commit nothing.
- The reference cannot be reached and wrangler's source is inconclusive: STOP and report; do not guess.

## Maintenance notes

- If a live account is available to the reviewer, one manual `createInstance` against a deployed workflow settles the contract beyond the docs.
