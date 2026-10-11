# Plan 488: Serve the scheduler dispatch route on the Node host so queue and topic handlers can call Lunora functions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/platform/src/capabilities packages/platform-node/src packages/queue/src packages/dispatch/src packages/runtime/src/create-worker.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — adds a new HTTP-shaped auth boundary (the dispatch route) to a host that has none today
- **Depends on**: none. Related to plan 480 (scheduler `/complete`) only if the same files are touched; check `git diff` against 480 before committing.
- **Category**: feature-parity bug
- **Planned at**: commit `dcffa4d73` (alpha), 2026-10-11

## Decision

Maintainer chose **option B**, with the recommended invocation path (recorded 2026-10-11): keep `queues` and `topics` at `emulated` for `node`, and make the Node host serve the dispatch route that `message.run` and `ctx.run` depend on. The route calls the function in-process through the same `@lunora/runtime` entry the HTTP path uses. That makes `@lunora/runtime` (and `@lunora/do` if the invoke path needs it) a real dependency of `platform-node`, not a devDependency. `@lunora/runtime` does not depend on `platform-node`, so this adds no cycle. The alternative (rate both `unsupported`) was rejected.

## Why this matters

A queue message or topic delivery on Node reaches a handler, the handler calls `message.run(api.x.y, args)` or `ctx.run(...)`, and that call POSTs to `LUNORA_ORIGIN_URL/_lunora/scheduler/dispatch`. Nothing on Node serves that path, so the call fails and the batch retries until `maxRetries` parks it. The rating says `emulated`; the delivery is one hop short. The note discloses this, but codegen reads the level, not the note.

## Current state

- **The sender.** `packages/dispatch/src/create-dispatch-runner.ts:370-400`: the runner requires `LUNORA_ORIGIN_URL` and `LUNORA_ADMIN_TOKEN` on the env (throws `INTERNAL` otherwise), builds `${origin}/_lunora/scheduler/dispatch`, and sends `authorization: Bearer <LUNORA_ADMIN_TOKEN>` plus `content-type: application/json`. It forwards `traceparent` and `x-lunora-userid` / `x-lunora-identity` when given. It takes an injectable `fetchImpl` (`DispatchRunnerOptions`). `packages/queue/src/run-context.ts:17,27-29` passes `fetchImpl` through, and `packages/queue/src/dispatch.ts:126,639` exposes it on `dispatchQueueBatch`.
- **The scheduler sender.** `packages/scheduler/src/scheduler-do.ts:716-745` signs the body with `x-lunora-scheduler-signature` when a scheduler secret exists, otherwise falls back to the admin bearer.
- **The receiver.** `packages/runtime/src/create-worker.ts:3551` `handleSchedulerDispatch`, registered at `:5609` as `[SCHEDULER_DISPATCH_PATH]`. Auth at `:3559-3562`: if `x-lunora-scheduler-signature` is present and `env.LUNORA_SCHEDULER_SECRET` is set, verify HMAC-SHA-256 over the raw body; else `checkAdminAuth(request, options.adminToken ?? env.LUNORA_ADMIN_TOKEN)` (`:2627`). Failure throws `DISPATCH_UNAUTHENTICATED` 403 (`:3567-3575`), a deliberately non-deterministic code so consumers retry rather than ack.
- **Request body** (`:3580-3640`): JSON with `functionPath` (required, else 400), `args`, `id` (the idempotency key), `shardKey` (defaults to the worker's default shard), optional `workflow`, optional `pool`. Identity is read from `x-lunora-userid` / `x-lunora-identity`, and `traceparent` is forwarded.
- **Response contract.** 2xx means done. A 409 with the `DISPATCH_DECLINED` header means "come back later" and is retried. Any other 4xx/5xx is retried by the caller (`scheduler-do.ts` comment near `:747-760`; `create-dispatch-runner.ts` maps the error envelope to `LunoraError`). The body on success is whatever the shard returns; on error a `LunoraError` JSON envelope.
- **The Node host serves no HTTP.** `packages/platform/src/capabilities/node.ts:94` (queues row) and `:213` (topics row) say `LUNORA_ORIGIN_URL`'s dispatch endpoint is served by "no Node HTTP server". The same gap appears in the workflows row (`node.ts:106`, `ctx.run dispatches to an endpoint no Node HTTP server serves`), so that note must change in the same commit.
- **Queue delivery on Node.** `packages/platform-node/src/node-queue-host.ts:193-196` takes `onBatch`; `:392` builds the env as `{ ...options.env }` plus `QUEUE_*` bindings. The batch is delivered only by `poll()` (see node.ts:94). `node-platform.ts` (around `:225-237`) requires `onQueueBatch` when `queues` is passed.
- **No function-invocation seam exists on Node.** `packages/platform-node/src/node-shard-registry.ts` has `onFetch` (`:174`), the "Node equivalent of `ShardDO.fetch`", and `stubFor` (`:273`) calls it. Nothing in the repo supplies it: `grep -rn "onFetch:" packages apps examples` finds only tests, and `createNodePlatform(` has no non-test caller.
- **Cloudflare's `/rpc` is Cloudflare-coupled.** `packages/do/src/shard-do.ts:7105` `handleFetchCloudflare` and `:7133` `/rpc` run on `this.state` (a `DurableObjectState`). `ShardRunner` (`packages/shard-engine/src/shard-runner.ts:41,153`) is host-neutral and takes `handlers.handleFetch`, so the Node shard can reuse the engine only through a handler the app supplies.
- **Dependency direction.** `packages/platform-node/package.json` lists `@lunora/do`, `@lunora/runtime`, and `@lunora/shard-engine` under `devDependencies`. A runtime import of any of them from `platform-node/src` would be a new dependency edge.
- **Node scheduler.** `packages/platform-node/src/node-scheduler-host.ts:108` `onDispatch` is caller-supplied, and no caller in the repo wires it. The Node scheduler does NOT already reach functions, so there is nothing to reuse there.

## Platform parity

- `queues` and `topics` for `node` stay **`emulated`**. The notes change: they describe the route now served and the gaps still open.
- `workflows` (`node.ts:106`) keeps `emulated`; its `ctx.run` gap note is updated in the same change, since the same route serves it.
- `cloudflare` rows are unchanged.
- The matrix vocabulary has no `partial`; do not add one.
- Mode `"pull"` queues stay unconsumed. Keep that sentence in the queues note (node.ts:94). Verify it is still true before editing it.
- The route is host-backed through the `SchedulerHost` / queue `onBatch` seam, not a provider API. Say so in the note.

## Commands

Confirm the scripts before use: `packages/platform-node/package.json` has `build`, `test`, `lint:types`, `lint:eslint`.

| Purpose               | Command                                                                    | Expected on success          |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| Build deps            | `pnpm --filter "@lunora/platform-node..." run build`                       | exit 0                       |
| Node host tests       | `pnpm --filter "@lunora/platform-node" run test`                           | all pass                     |
| Platform matrix tests | `pnpm --filter "@lunora/platform" run test`                                | all pass                     |
| Queue/dispatch tests  | `pnpm --filter "@lunora/queue" run test` and `--filter "@lunora/dispatch"` | all pass                     |
| Types                 | `pnpm --filter "@lunora/platform-node" run lint:types`                     | exit 0                       |
| API snapshot          | `pnpm run api:check`                                                       | exit 0 (after a fresh build) |

Run `pnpm run build:packages` before `api:check` (see the stale-dist gotcha in `CLAUDE.md`).

## Scope

**In scope**

- New `packages/platform-node/src/node-dispatch-route.ts` (name may change; keep it one file) that authenticates and forwards a dispatch request.
- `packages/platform-node/src/index.ts` export of the new route.
- `packages/platform-node/__tests__/` — a new test file for the route.
- `packages/platform/src/capabilities/node.ts` — the `queues`, `topics`, and `workflows` note texts only. Levels stay `emulated`.
- `packages/platform/__tests__/` — matrix assertions if any already pin these notes.
- `plans/README.md` status row for 488.

**Out of scope**

- Changing `create-worker.ts`, `create-dispatch-runner.ts`, `scheduler-do.ts`, or the wire format. The route must match them, not change them.
- Adding a Node app entry, a dev server, or `pnpm dev --target node`. That is a separate plan.
- Adding `@lunora/runtime` / `@lunora/do` as a runtime dependency of `platform-node` is decided and in scope. Move them from `devDependencies` to `dependencies` (Step 4).
- Consuming `mode: "pull"` queues.
- Cloudflare and celld rows.

## Git workflow

- Branch: `advisor/488-node-dispatch-route`, from `alpha` (`dcffa4d73`).
- One commit. Do NOT push and do NOT open a PR unless the operator says so.
- Subject example: `feat(platform-node): serve the scheduler dispatch route for queue and topic handlers`.
- Body must say the dispatch route is **new on alpha** (no Node dispatch route existed before), name the auth it accepts (HMAC when `LUNORA_SCHEDULER_SECRET` is set, else admin bearer), and state the `invoke` seam the caller must supply. Do not name any other project as a source. Wrap body lines at 100 characters.

## Steps

### Step 1: Failing test first

Create `packages/platform-node/__tests__/node-dispatch-route.test.ts`. It must:

1. POST a JSON body `{ functionPath, args, shardKey, id }` with `authorization: Bearer <token>` to the route; expect 200 and that the injected `invoke` was called once with those values.
2. POST with a wrong bearer; expect 403 and a `DISPATCH_UNAUTHENTICATED` envelope; `invoke` NOT called.
3. POST with a valid `x-lunora-scheduler-signature` (HMAC over the exact body, secret `LUNORA_SCHEDULER_SECRET`); expect 200.
4. POST a body missing `functionPath`; expect 400 `BAD_REQUEST`.
5. POST with `GET`; expect 405 or the same method error `create-worker.ts` raises via `assertMethod`.

**Verify**: `pnpm --filter "@lunora/platform-node" run test` fails on the new file (module missing). Record the failure.

### Step 2: Implement the route

Create the route as a plain `(request: Request) => Promise<Response>` factory with an injected `invoke(functionPath, args, shardKey, id, identity)`. Reuse the same auth rules as `create-worker.ts:3559-3575` (copy the logic; do not import from `@lunora/runtime`). Parse the body the same way (`create-worker.ts:3580-3640`), and return the success and error envelopes in the same shape.

Export it from `packages/platform-node/src/index.ts`.

**Verify**: `pnpm --filter "@lunora/platform-node" run test` passes the new file; `lint:types` exits 0.

### Step 3: Wire the Node queue delivery through the route

The queue consumer already receives `env`. Give `createNodePlatform` (or the caller) a way to pass `fetchImpl` into `dispatchQueueBatch` so a `ctx.run` / `message.run` call reaches the route in-process, with `LUNORA_ORIGIN_URL` set to a value the route answers for. Prefer `fetchImpl` over a real HTTP listener: this host has no server, and a listener would be a new surface.

**Verify**: a test in `packages/platform-node/__tests__/` runs a queue batch whose handler calls `message.run` and asserts the route's `invoke` ran once. Use a stub `invoke`; a real Lunora function is Step 4.

### Step 4: End-to-end with a real function (the gate that matters)

Run one real compiled Lunora function through the route. Use the `NodeShard` from `createNodeShardRegistry` and an `onFetch` that answers `/rpc` through `ShardRunner` (`packages/shard-engine/src/shard-runner.ts`). The function body must come from the same shard-engine code the Node engine-conformance test already runs (`packages/platform-node/__tests__/engine-conformance.test.ts`).

This is the decided invocation path. Move `@lunora/runtime` (and `@lunora/do` only if the invoke path needs it) from `devDependencies` to `dependencies` of `platform-node`, then wire `createNodePlatform` so the dispatch route's `invoke` calls the runtime entry in-process, and wire `onFetch` the same way. Run `pnpm run lint:package-json` after editing the manifest, since key order is checked only there. Confirm no cycle with `pnpm --filter "@lunora/platform-node..." run build`.

**Verify**: the test asserts a row written by the function is visible in the shard afterwards.

### Step 5: Matrix note update

Edit `packages/platform/src/capabilities/node.ts`:

- `queues` (`:92-95`): level stays `emulated`; the note now says the dispatch route is served by `node-dispatch-route` when the caller wires `fetchImpl` and `invoke`, and that `mode: "pull"` stays unconsumed. Remove the sentence that says no Node HTTP server serves the endpoint.
- `topics` (`:210-213`): same change for the inherited gap.
- `workflows` (`:106`): replace the `ctx.run dispatches to an endpoint no Node HTTP server serves` clause.

**Verify**: `grep -n "no Node HTTP server" packages/platform/src/capabilities/node.ts` returns nothing. `pnpm --filter "@lunora/platform" run test` passes.

### Step 6: Codegen and API verify

- `pnpm --filter "@lunora/codegen" run test` must exit 0. A golden fixture should not change, since no level changed. If one does, STOP.
- `pnpm run build:packages` then `pnpm run api:check` exits 0. If `api:check` drifts, do NOT run `api:update` without reporting the diff.

## Test plan

- Route unit tests (Step 1): auth paths, body validation, invoke called with the wire values.
- Queue integration (Step 3): `message.run` reaches the route in-process.
- Real-function test (Step 4): a row written by a Lunora function on Node.
- Matrix: `node` `queues` / `topics` / `workflows` stay `emulated`, notes updated.
- The workerd gate (`pnpm run test:workerd`) applies only if SQL or a Durable Object is touched. This plan touches neither directly; run it only if Step 4 changes shard-engine files.

## Done criteria

- [ ] Step 1 test was red before Step 2 and green after.
- [ ] Step 4 real-function test passes and asserts a shard write.
- [ ] `node` `queues` and `topics` are still `emulated`; both notes match what is served.
- [ ] `grep -n "no Node HTTP server" packages/platform/src/capabilities/node.ts` returns nothing.
- [ ] `pnpm --filter "@lunora/platform-node" run test`, `--filter "@lunora/platform" run test`, `--filter "@lunora/queue" run test`, and `--filter "@lunora/codegen" run test` exit 0.
- [ ] `pnpm run api:check` exits 0 after a fresh build.
- [ ] `git status` shows changes only in scope; one commit on `advisor/488-node-dispatch-route`; nothing pushed.
- [ ] `plans/README.md` row for 488 updated.

## STOP conditions

- **STOP** if moving the dependency creates a cycle, fails the build, or contradicts the layering in `.agents/docs/packages.md`. Report it; do not work around it.
- **STOP** if the dispatch auth cannot be satisfied with the secrets that already exist (`LUNORA_SCHEDULER_SECRET` or `LUNORA_ADMIN_TOKEN`). Do not invent a new secret. Report and stop.
- **STOP** if the route needs a real HTTP listener to reach `LUNORA_ORIGIN_URL` and `fetchImpl` cannot carry it. A listener is a new surface; report.
- **STOP** if a golden fixture or another target's matrix row changes.
- **STOP** if `plans/480` and this plan both modify the same scheduler files; sequence them first.

## Maintenance notes

- Reviewers: the route is new on alpha. A future Node app entry must wire `invoke` and `fetchImpl` in the same change that it lands; until then the note says the route exists but only a caller that supplies `invoke` can serve it.
- Check the note text, not only the level: this is the parity class that has shipped wrong before.
- The `emulated` rating here is honest only if Step 4 passes. A unit test with a stub `invoke` does not prove a Lunora function runs on Node.
