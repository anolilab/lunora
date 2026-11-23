# Plan 622: Design spike: split `createWorker` into context-taking modules, first cluster extracted

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/runtime/src/create-worker.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE (spike + one extraction), pushed: `refactor/runtime-shard-authorization` (workerd: runtime); remaining clusters listed in the plan file; PR #1646

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`packages/runtime/src/create-worker.ts` is 7,400 lines; `const createWorker = (options: WorkerOptions): LunoraWorker => {` starts at line 3138 and runs ~3,900 lines as one closure with about 64 inner helper functions, and `WorkerOptions` is a ~980-line interface (from line ~988). The file took 77 commits between 2026-08-20 and 2026-11-20 — admin tokens, scheduler outbox, agent routing, x402, static-asset headers — so unrelated features keep editing one shared closure, and none of its helpers can be unit-tested without building a whole worker. The repo is already splitting the equivalent client god-file (repo plan 467, `lunora-client.ts`). This plan is a **spike with one real extraction**: produce the map and the seam, prove it on the lowest-risk cluster, and stop.

## Current state

- `packages/runtime/src/create-worker.ts` — see above. Count helpers: `rg -c "^    const [a-zA-Z]+ = (async )?\\(" packages/runtime/src/create-worker.ts`.
- Already-extracted route modules show the house style for a split-out cluster: `packages/runtime/src/auth-admin-routes.ts` and `packages/runtime/src/workflows-admin-routes.ts` (a descriptor table plus a handler factory that receives what it needs as arguments). **Match these.**
- Tests: `packages/runtime/__tests__/` (~105 files), including `create-worker.test.ts`, `auth-admin.test.ts`, `named-admin-tokens.test.ts`.
- Public API of the package is pinned by `api-snapshots/runtime.api.md`; `createWorker`, `WorkerOptions` and `LunoraWorker` must not change shape.

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

| Purpose                       | Command                                                                           | Expected on success |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                  | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/runtime..." run build`                                    | exit 0              |
| One test file                 | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/create-worker.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/runtime" run test`                                        | all pass            |
| Types                         | `pnpm --filter "@lunora/runtime" run lint:types`                                  | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/runtime" run lint:eslint`                                 | exit 0, 0 warnings  |
| Public API                    | `pnpm run api:check`                                                              | exit 0, no diff     |

## Scope

**In scope**: `packages/runtime/src/create-worker.ts`; new files under `packages/runtime/src/worker/` (create); `packages/runtime/__tests__/worker/` (create); a design note appended to **this plan file** under a new heading "## Spike findings" (the only doc you write).

**Out of scope**: behaviour changes of any kind; `WorkerOptions` fields; other packages; splitting more than one cluster; renaming exported symbols.

## Git workflow

- Branch: `fix/547-create-worker-split-spike` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `refactor(runtime): extract the <cluster> routes from createWorker`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: map (no code changes)

List every inner helper of `createWorker` with: name, line, the closure variables it reads (`options`, resolved per-worker state such as trusted-upstream checks, default shard, registry, env accessors), the closure variables it **writes**, and which other helpers it calls. Group them into clusters (expected: admin + named tokens, scheduler dispatch, HTTP actions, RPC envelope/batch, REST router, static assets/SSR, websocket upgrade, x402/payment, agent routing). Write the table into "## Spike findings" in this file.

### Step 2: define the seam

From the map, define `interface WorkerRuntimeContext` (in `packages/runtime/src/worker/context.ts`): the read-only per-worker values that clusters need, built once inside `createWorker`. Rules: no mutable shared fields on it — a helper that writes closure state stays in `createWorker` for now and is listed as "not yet extractable" with the reason. Not exported from the package index.

### Step 3: extract ONE cluster

Pick the cluster with (a) no writes to closure state and (b) the best existing test coverage — report why you chose it. Move its helpers to `packages/runtime/src/worker/<cluster>.ts` as functions taking `(context: WorkerRuntimeContext, ...)`; `createWorker` calls them. Pure move: no logic edits, no reordered checks, comments move with their code.

**Verify after the move**: `pnpm --filter "@lunora/runtime" run test` → all pass with **zero test edits**; `lint:types`, `lint:eslint` exit 0; `pnpm --filter "@lunora/runtime" run build && pnpm run api:check` → no diff.

### Step 4: one direct unit test

Add `packages/runtime/__tests__/worker/<cluster>.test.ts` calling an extracted function directly with a hand-built `WorkerRuntimeContext` — the thing that was impossible before. Two or three cases copied in spirit from the existing worker-level tests for that cluster.

### Step 5: write up

In "## Spike findings": the cluster table, the context interface, what was extracted and its line delta, the proposed order for the remaining clusters with a risk note each, and every "not yet extractable" helper with the state it mutates.

## Done criteria

- [ ] `create-worker.ts` is shorter by the extracted cluster's size; `git diff --stat` shows only in-scope paths
- [ ] `pnpm --filter "@lunora/runtime" run test` exits 0 with no pre-existing test file modified (`git diff --stat 093c5e41f..HEAD -- packages/runtime/__tests__` shows only the new file)
- [ ] `pnpm run api:check` exits 0 with no snapshot change
- [ ] "## Spike findings" exists in this file with the five items of step 5

## STOP conditions

- No cluster is free of closure-state writes (then deliver steps 1, 2, 5 only and say so).
- Any existing test needs editing to pass after the move.
- `api:check` shows a diff.
- The extraction needs a circular import between `create-worker.ts` and the new module.

## Maintenance notes

- Follow-up extractions should be one cluster per PR, each a pure move; the file's churn means long-lived refactor branches will conflict.
- Reviewer: diff the moved code with `git diff --color-moved=zebra` and confirm it is a move.

## Spike findings

Line numbers are from baseline `4a7c48bfd` (before the extraction). `createWorker` spans lines 3138 to ~7040 and holds about 120 closure declarations.

### 1. Map

The listing is generated by scanning each closure-level declaration for the sibling declarations it mentions and the `options.*` fields it reads. Format: `lines name | reads options | calls | WRITES`. A trailing `WRITES:<x>` marks a closure `let` the helper assigns.

```
3143-3143 isTrustedUpstream | reads options: trustInboundTraceContext | calls:
3144-3144 noticeDroppedTrace | reads options: trustInboundTraceContext | calls:
3145-3147 defaultShard | reads options: defaultShardKey | calls:
3148-3157 assertAgentRunOnDefaultShard | reads options:  | calls: defaultShard
3158-3166 queryCoordinator | reads options: queryCoordinator,resolveTableSharding,resolveIdentity | calls: defaultShard
3167-3174 publicResolveIdentity | reads options: resolveIdentity,identity,shardDO,schedulerDO,jurisdiction | calls: forwardToShard
3175-3175 shardDO | reads options: shardDO,jurisdiction | calls:
3176-3178 schedulerDO | reads options: schedulerDO,jurisdiction | calls:
3179-3191 voiceAgents | reads options: voiceAgents,jurisdiction,shardRegion | calls:
3192-3211 warnedPlacementUnderResidency | reads options:  | calls:
3212-3228 placementUnderResidency | reads options: jurisdiction | calls: warnedPlacementUnderResidency | WRITES:warnedPlacementUnderResidency
3229-3242 forwardToShard | reads options: shardRegion,adminToken | calls: placementUnderResidency,ensureSecurityResolved
3243-3243 envAdminToken | reads options:  | calls:
3244-3250 effectiveAdminToken | reads options: adminToken | calls: envAdminToken
3251-3257 shardBindingName | reads options:  | calls:
3258-3281 captureEnvDerivedConfig | reads options: shardDO,adminToken,adminGate | calls: envAdminToken,shardBindingName,requestIsAdmin,handle | WRITES:envAdminToken
3282-3286 adminGrants | reads options: adminGate | calls: handle
3287-3291 requestIsAdmin | reads options:  | calls: effectiveAdminToken,adminGrants
3292-3300 requestIsRootAdmin | reads options:  | calls: effectiveAdminToken,adminGrants
3301-3317 assertMigrationsAdmin | reads options:  | calls: adminGrants,requestIsAdmin,requestIsRootAdmin
3318-3348 callTokenStore | reads options:  | calls: defaultShard,shardDO,forwardToShard,effectiveAdminToken
3349-3353 adminRevocations | reads options: adminRevocations,jurisdiction | calls: effectiveAdminToken
3354-3412 adminTokenVerifier | reads options: adminGate | calls: requestIsAdmin,callTokenStore,adminRevocations,serveReservedWorkerRpc,applyAdminGate
3413-3459 recordAdminGrant | reads options: adminGate | calls: shardDO,effectiveAdminToken,adminGrants,requestIsAdmin,adminTokenVerifier
3460-3534 forwardContext | reads options: trustedClientIpHeader,functions | calls: effectiveAdminToken,adminGrants,adminTokenVerifier,serverQuery
3535-3552 forwardCallerContext | reads options:  | calls: forwardContext
3553-3577 resolveAdminForwardContext | reads options: resolveIdentity | calls: effectiveAdminToken,adminGrants,forwardContext
3578-3580 warnedUnauthenticatedShardAccess | reads options:  | calls: replicaTargetFor
3581-3581 warnedReplicaReadsWithoutRegistry | reads options:  | calls:
3582-3592 warnReplicaReadsWithoutRegistry | reads options:  | calls: warnedReplicaReadsWithoutRegistry | WRITES:warnedReplicaReadsWithoutRegistry
3593-3637 guardUnauthenticatedShardAccess | reads options: allowUnauthenticatedShardAccess | calls: warnedUnauthenticatedShardAccess,serverQuery | WRITES:warnedUnauthenticatedShardAccess
3638-3668 assertShardAuthorized | reads options: authorizeShard | calls: defaultShard,guardUnauthenticatedShardAccess,serverQuery
3669-3698 orchestrationAdminRoutes | reads options: listSchemaTables,resolveTableSharding | calls: defaultShard,queryCoordinator,shardDO,forwardToShard,requestIsAdmin,resolveAdminForwardContext,dispatchToShard
3699-3746 publishLiveToShard | reads options:  | calls: defaultShard,shardDO,forwardToShard,assertShardAuthorized,handleSchedulerDispatch
3747-3817 dispatchToShard | reads options:  | calls: assertAgentRunOnDefaultShard,shardDO,forwardToShard,runOneCronJob,handleSchedulerDispatch
3818-3861 startWorkflowInstance | reads options:  | calls:
3862-3877 scheduledWorkflowParams | reads options: agentWorkflows | calls:
3878-3924 runOneCronJob | reads options:  | calls: defaultShard,dispatchToShard,startWorkflowInstance
3925-3930 assertAdminAuthorized | reads options:  | calls: requestIsAdmin
3931-3942 assertRootAdmin | reads options:  | calls: requestIsRootAdmin,assertAdminAuthorized
3943-3953 requireAdminOption | reads options:  | calls: assertAdminAuthorized
3954-3956 cronRunStub | reads options: schedulerInstanceName | calls: schedulerDO
3957-3974 deploymentPause | reads options:  | calls: schedulerDO,effectiveAdminToken,requestIsAdmin,recordAdminGrant,assertAdminAuthorized,cronRunStub,applyAdminGate
3975-3989 isPaused | reads options:  | calls: deploymentPause
3990-4036 runCronJobs | reads options: cronJobs | calls: runOneCronJob,cronRunStub
4037-4098 handleRunCronJob | reads options: cronJobs | calls: runOneCronJob,assertAdminAuthorized,cronRunStub
4099-4137 releasePoolSlot | reads options:  | calls: schedulerDO
4138-4269 handleSchedulerDispatch | reads options: adminToken | calls: defaultShard,dispatchToShard,startWorkflowInstance,scheduledWorkflowParams,assertAdminAuthorized,releasePoolSlot,getAuthAuditLog,handleRpc
4270-4278 getAuthAuditLog | reads options: authAuditReader | calls: assertAdminAuthorized
4279-4287 authJurisdictionMove | reads options: authJurisdictionMove | calls: assertRootAdmin,aiChat
4288-4337 aiRpcDeps | reads options: aiChatBinding,aiOptInLevel | calls: defaultShard,forwardToShard,effectiveAdminToken,adminGrants,forwardContext,resolveAdminForwardContext,assertAdminAuthorized,forwardRpcToShard,resolvedSecurity
4338-4346 aiChat | reads options:  | calls: aiRpcDeps,aiAvailable
4347-4347 aiAvailable | reads options:  | calls: aiRpcDeps
4348-4360 aiOneShotGate | reads options: notifySubscriptionStore | calls: aiRpcDeps,listPushSubscriptions
4361-4425 listPushSubscriptions | reads options: notifySubscriptionStore | calls: assertAdminAuthorized,getAuthAuditLog,aiChat,aiAvailable,assertDispatchableEnvelope,handleRpc
4426-4481 serveReservedWorkerRpc | reads options:  | calls: getAuthAuditLog,authJurisdictionMove,aiChat,aiAvailable,aiOneShotGate,listPushSubscriptions,forwardRpcToShard,applyAdminGate
4482-4504 dataMovementAdminRoutes | reads options: applyGlobals,exportCursorStore,exportSinks,listSchemaTables,syncGlobals | calls: defaultShard,queryCoordinator,shardDO,resolveAdminForwardContext,assertAdminAuthorized
4505-4512 sqlMigrationAdminRoutes | reads options: applySqlMigrations | calls: requestIsAdmin,requestIsRootAdmin,assertMigrationsAdmin
4513-4524 queryParameter | reads options:  | calls:
4525-4537 parsePaging | reads options:  | calls:
4538-4545 requireSchedulerNamespace | reads options:  | calls: schedulerDO
4546-4554 resolveSchedulerStub | reads options: schedulerInstanceName | calls: assertAdminAuthorized,requireSchedulerNamespace
4555-4566 scheduledAdminRoutes | reads options: schedulerInstanceName,workflowsClient | calls: effectiveAdminToken,requestIsRootAdmin,requireSchedulerNamespace,resolveSchedulerStub
4567-4574 workflowsAdminRoutes | reads options: workflowsClient | calls: assertAdminAuthorized
4575-4593 storageAdminRoutes | reads options: storageBuckets,storageDelete,storageDownload,storageList,storageSignedUrl,storageUpload | calls: assertAdminAuthorized,assertRootAdmin,requireAdminOption,queryParameter,parsePaging
4594-4599 backupAdminRoutes | reads options:  | calls: requireAdminOption
4600-4605 vectorAdminRoutes | reads options: vectorIntrospector | calls: requireAdminOption
4606-4613 adminTokenRoutes | reads options:  | calls: callTokenStore,adminRevocations,adminTokenVerifier,assertRootAdmin
4614-4619 kvAdminRoutes | reads options: kvIntrospector | calls: requireAdminOption
4620-4625 logArchiveAdminRoutes | reads options: logArchive | calls: requireAdminOption
4626-4646 introspectionAdminRoutes | reads options: cronJobs,functions,globalIntrospector,architecture,openApiSpec,openRpcSpec | calls: assertAdminAuthorized,requireAdminOption,queryParameter,parsePaging
4647-4678 resolveHealthProbes | reads options: health | calls: defaultShard,shardDO
4679-4700 healthRoutes | reads options: health | calls: requestIsAdmin,resolveHealthProbes
4701-4859 buildHttpScheduler | reads options: schedulerInstanceName | calls: defaultShard,assertShardAuthorized
4860-5030 buildHttpActionContext | reads options: liveStreams,storage | calls: defaultShard,assertAgentRunOnDefaultShard,publicResolveIdentity,shardDO,schedulerDO,forwardToShard,forwardContext,assertShardAuthorized,publishLiveToShard,buildHttpScheduler,answerMiss,dispatchSingleShard,handleRpc,serverQuery
5031-5037 servedAssets | reads options:  | calls:
5038-5054 answerMiss | reads options: spaAssets | calls: servedAssets
5055-5087 answerRouterMiss | reads options: authDiscoveryHandler | calls: servedAssets,answerMiss
5088-5152 dispatchHttpRoute | reads options: httpRouter | calls: buildHttpActionContext,handleRpc,serverQuery
5153-5158 socketRoutePaths | reads options: functions | calls:
5159-5268 handleWebSocketUpgrade | reads options: shardDO | calls: defaultShard,publicResolveIdentity,shardDO,forwardToShard,effectiveAdminToken,requestIsRootAdmin,forwardContext,assertShardAuthorized,scheduledAdminRoutes,socketRoutePaths,authorizeRpcEnvelope,resolvedSecurity
5269-5324 handleSocketReauth | reads options: shardDO | calls: defaultShard,publicResolveIdentity,shardDO,forwardToShard,effectiveAdminToken,requestIsAdmin,forwardContext,assertShardAuthorized
5325-5352 handleClaimsFingerprint | reads options: voiceAgents | calls: publicResolveIdentity,forwardCallerContext,handleWebSocketUpgrade
5353-5443 handleVoiceUpgrade | reads options: authorizeShard | calls: publicResolveIdentity,voiceAgents,forwardToShard,effectiveAdminToken,forwardContext,guardUnauthenticatedShardAccess,assertShardAuthorized,handleWebSocketUpgrade,authorizeRpcEnvelope,resolvedSecurity
5444-5489 authorizeFanOutEnvelope | reads options: authorizeFanOut,authorizeShard | calls: guardUnauthenticatedShardAccess
5490-5537 authorizeRpcEnvelope | reads options:  | calls: defaultShard,assertAgentRunOnDefaultShard,assertShardAuthorized,authorizeFanOutEnvelope,serverQuery
5538-5575 replicaTargetFor | reads options: replicaReads,functions | calls: warnReplicaReadsWithoutRegistry
5576-5629 forwardRpcToShard | reads options:  | calls: shardDO,forwardToShard,shardBindingName,authorizeRpcEnvelope,replicaTargetFor,handleRpc,serverQuery
5630-5753 dispatchSingleShard | reads options:  | calls: isTrustedUpstream,noticeDroppedTrace,forwardRpcToShard,handleRpc
5754-5763 assertDispatchableEnvelope | reads options:  | calls:
5764-5899 handleRpc | reads options: x | calls: defaultShard,queryCoordinator,publicResolveIdentity,shardDO,recordAdminGrant,forwardCallerContext,serveReservedWorkerRpc,authorizeRpcEnvelope,dispatchSingleShard,assertDispatchableEnvelope
5900-6240 handleBatchRpc | reads options: functions | calls: isTrustedUpstream,noticeDroppedTrace,defaultShard,publicResolveIdentity,shardDO,forwardToShard,forwardContext,forwardCallerContext,authorizeRpcEnvelope,dispatchSingleShard,handleRpc,serverQuery,handle
6241-6344 serverQuery | reads options: x | calls: defaultShard,publicResolveIdentity,forwardCallerContext,authorizeRpcEnvelope,dispatchSingleShard,handleRpc
6345-6381 instrumentTrigger | reads options:  | calls:
6382-6403 runUserCron | reads options:  | calls: isPaused
6404-6462 handleScheduled | reads options: crons,backupStore,backupCron,cronJobs | calls: queryCoordinator,shardDO,effectiveAdminToken,captureEnvDerivedConfig,runCronJobs,runUserCron
6463-6485 tenantFanoutRoutes | reads options: queueHandler,adminToken | calls: assertAdminAuthorized,isPaused,handleScheduled
6486-6523 recordAuthAttempt | reads options: adminToken | calls: defaultShard,shardDO,forwardToShard
6524-6563 dispatchAuth | reads options: authHandler,authBasePath | calls: authorizeRpcEnvelope,dispatchSingleShard,handleRpc,recordAuthAttempt
6564-6592 invokeExposed | reads options: x | calls: defaultShard,publicResolveIdentity,forwardCallerContext,authorizeRpcEnvelope,dispatchSingleShard,serverQuery
6593-6609 restRoutes | reads options: functions,restEdgeCache,restRateLimit | calls: invokeExposed
6610-6610 customRoutes | reads options: routes | calls:
6611-6614 liveStreamRouteKeys | reads options: liveStreamRoutes | calls:
6615-6630 explicitRouteFor | reads options:  | calls: customRoutes,liveStreamRouteKeys
6631-6737 internalRoutes | reads options: authAdmin | calls: effectiveAdminToken,assertAdminAuthorized,assertRootAdmin,deploymentPause,handleRunCronJob,handleSchedulerDispatch,queryParameter,parsePaging,handleWebSocketUpgrade,handleSocketReauth,handleClaimsFingerprint,handleRpc,handleBatchRpc,applyAdminGate
6738-6745 resolvedSecurity | reads options: security | calls:
6746-6758 asStaticAsset | reads options:  | calls: resolvedSecurity
6759-6766 securityEnvResolved | reads options:  | calls: handle
6767-6778 ensureSecurityResolved | reads options: security | calls: recordAdminGrant,resolvedSecurity,securityEnvResolved | WRITES:resolvedSecurity,securityEnvResolved
6779-6805 applyAdminGate | reads options:  | calls: recordAdminGrant
6806-6829 enforceDeclaredBodyLimit | reads options: authHandler,authBasePath | calls:
6830-7017 handle | reads options: voiceAgents,spaAssets,httpRouter,passThroughOnException,observability,liveStreams,queue,queueFetchImpl | calls: voiceAgents,captureEnvDerivedConfig,publishLiveToShard,deploymentPause,servedAssets,answerRouterMiss,dispatchHttpRoute,socketRoutePaths,handleWebSocketUpgrade,handleVoiceUpgrade,serverQuery,instrumentTrigger,handleScheduled,tenantFanoutRoutes,dispatchAuth,restRoutes,customRoutes,explicitRouteFor,internalRoutes,resolvedSecurity,asStaticAsset,ensureSecurityResolved,applyAdminGate,enforceDeclaredBodyLimit
```

Closure `let` state (the only things that block a pure move): `warnedPlacementUnderResidency`, `envAdminToken`, `shardBindingName` (written in `captureEnvDerivedConfig`), `warnedUnauthenticatedShardAccess`, `warnedReplicaReadsWithoutRegistry`, `resolvedSecurity` and `securityEnvResolved` (written in `ensureSecurityResolved`).

Clusters:

| Cluster                       | Helpers                                                                                                                                                                                                       | Writes closure state                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| shard authorization           | assertShardAuthorized, authorizeFanOutEnvelope, authorizeRpcEnvelope                                                                                                                                          | none (guardUnauthenticatedShardAccess, which they call, writes) |
| admin + named tokens          | effectiveAdminToken, captureEnvDerivedConfig, adminGrants, requestIsAdmin/RootAdmin, callTokenStore, adminTokenVerifier, recordAdminGrant, assertAdminAuthorized, applyAdminGate, all `*AdminRoutes` builders | captureEnvDerivedConfig (envAdminToken, shardBindingName)       |
| scheduler dispatch / cron     | runOneCronJob, runCronJobs, handleRunCronJob, handleSchedulerDispatch, releasePoolSlot, startWorkflowInstance, deploymentPause, handleScheduled                                                               | none directly; depends on the admin cluster                     |
| HTTP actions                  | buildHttpScheduler, buildHttpActionContext, publishLiveToShard                                                                                                                                                | none                                                            |
| RPC envelope / batch          | handleRpc, handleBatchRpc, dispatchSingleShard, forwardRpcToShard, serverQuery, replicaTargetFor                                                                                                              | replicaTargetFor via warnReplicaReadsWithoutRegistry            |
| REST router / internal routes | restRoutes, invokeExposed, explicitRouteFor, internalRoutes                                                                                                                                                   | none                                                            |
| static assets / security      | servedAssets, answerMiss, answerRouterMiss, asStaticAsset, ensureSecurityResolved                                                                                                                             | ensureSecurityResolved                                          |
| websocket / voice             | handleWebSocketUpgrade, handleSocketReauth, handleClaimsFingerprint, handleVoiceUpgrade                                                                                                                       | none                                                            |
| AI / reserved worker RPC      | aiRpcDeps, aiChat, aiAvailable, aiOneShotGate, listPushSubscriptions, serveReservedWorkerRpc                                                                                                                  | none                                                            |
| agent routing / x402          | assertAgentRunOnDefaultShard (here), x402 gating lives in module-level helpers outside the closure                                                                                                            | none                                                            |

### 2. The seam

`packages/runtime/src/worker/context.ts` exports `WorkerRuntimeContext` (not re-exported from the package index): `assertAgentRunOnDefaultShard`, `authorizeFanOut`, `authorizeShard`, `defaultShard` and `guardUnauthenticatedShardAccess`, all `readonly`. It is built once in `createWorker` as `workerContext`. Fields are added per extracted cluster, not up front. Types are structural mirrors (`AuthorizeShardCaller`, `AuthorizableEnvelope`) because `RpcEnvelope`, `ShardCaller` and `WorkerOptions` are declared in `create-worker.ts`; importing them would make the new modules depend on it. A later step should move those declarations into a leaf types module.

### 3. Extracted

Cluster: shard authorization (`assertShardAuthorized`, `authorizeFanOutEnvelope`, `authorizeRpcEnvelope`, plus the module-level `grants` they and the admin gate share), now in `packages/runtime/src/worker/shard-authorization.ts`. Chosen because it assigns no closure state itself, every transport funnels through it, and `create-worker`, `rpc-forward`, `server-query`, `rest-surface`, `cross-shard-relations` and `ws-upgrade-admin` tests already exercise it. `createWorker` keeps two thin wrappers with the old names and signatures, so no call site changed.

Line delta: `create-worker.ts` 7400 to 7262 (-138; 14 insertions, 152 deletions). New code: 24 lines in `context.ts`, 179 in `shard-authorization.ts`.

### 4. Remaining order

1. HTTP actions (`buildHttpScheduler`, `buildHttpActionContext`): no writes; needs the context to grow by shard namespaces and forward helpers. Low risk.
2. REST router (`invokeExposed`, `restRoutes`, `explicitRouteFor`): no writes, already delegates to `rest-routes`. Low risk.
3. RPC envelope / batch: large and the hot path; `replicaTargetFor` first needs its warn-once flag turned into an injected function. Medium risk.
4. Scheduler / cron: depends on the admin cluster and `deploymentPause`. Medium risk.
5. Websocket / voice: reads the admin and identity helpers; many call sites. Medium risk.
6. Admin + named tokens: `captureEnvDerivedConfig` mutates `envAdminToken` and `shardBindingName`; those need a small per-worker mutable holder object. Highest risk, security-sensitive.
7. Static assets / security: `ensureSecurityResolved` mutates `resolvedSecurity`/`securityEnvResolved`. Medium risk.

### 5. Not yet extractable

| Helper                          | State it mutates                      |
| ------------------------------- | ------------------------------------- |
| placementUnderResidency         | warnedPlacementUnderResidency         |
| captureEnvDerivedConfig         | envAdminToken, shardBindingName       |
| warnReplicaReadsWithoutRegistry | warnedReplicaReadsWithoutRegistry     |
| guardUnauthenticatedShardAccess | warnedUnauthenticatedShardAccess      |
| ensureSecurityResolved          | resolvedSecurity, securityEnvResolved |
