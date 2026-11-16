# Lunora audit 2026-11-11 — vetted findings (audited at commit 5ed1688b6)

All paths are repo-relative; line numbers are for commit `5ed1688b6`.
`origin/alpha` has moved on by ~72 commits (tip `4a7c48bfd` at the time of writing), so every line
number is a lead: re-open the code at the tip you plan against.

"Vetted" means the advisor opened the cited code and confirmed the mechanism. Rows 13–20 were
spot-checked (counts and cited lines), row 21 is as reported by the audit pass.

## EXECUTE (write a plan, dispatch an executor, review)

### 1. Hard `deleteAll` / `wipeShard` skips rows that are already soft-deleted (bug, erasure) — S, LOW risk, HIGH confidence

- `packages/shard-engine/src/ctx-db.ts:3829` — `deleteAll` pages with `writer.findMany(tableName, { limit: chunkSize })`, no `includeDeleted`.
- `packages/shard-engine/src/query-args.ts:698-699` — `softDeleteScope` hides soft-deleted rows unless `includeDeleted === true`.
- `packages/shard-engine/src/ctx-db.ts:5250-5253` — `wipeShard` calls `deleteAll(name, { hard: true })`, comment "Erasure means gone, not marked".
- `packages/server/src/types.ts:1412-1413` — docs call `{ hard: true }` "what GDPR erasure means".
- Cascades already pass `includeDeleted: hard` (`ctx-db.ts:3693`).
- No test: `packages/shard-engine/__tests__/ctx-db.erase.test.ts` has no soft-delete case.
- Fix sketch: pass `includeDeleted: allOptions?.hard === true` on the paging read; add an erase test over rows soft-deleted beforehand (must fail without the fix). Check the `.global()` twin path (`deleteGlobalByIds`) behaves the same. Touches storage → needs the workerd suite.

### 2. A failed pause-flag read caches "not paused" even when the isolate last knew it was paused (bug) — S, LOW risk, MED confidence (intent)

- `packages/runtime/src/deployment-pause.ts:205-209` — the `.catch` sets `cached = { state: NOT_PAUSED }` and returns `NOT_PAUSED`.
- `:223` — the deadline branch uses `cached?.state ?? NOT_PAUSED` ("the last state this isolate trusted stands").
- The docblock above (`~:183-188`) says fail-open on a scheduler outage is deliberate; that stays true for an isolate with no prior state.
- `packages/runtime/__tests__/deployment-pause.test.ts` has no case for a failed read after a paused one.
- Fix sketch: in the `.catch`, fall back to `cached?.state ?? NOT_PAUSED` like the deadline branch; add the test.

### 3. Many-to-many through a `.softDelete()` join table: a disconnected pair can never be re-linked (bug) — S, LOW risk, MED-HIGH confidence

- `packages/server/src/relation-writes.ts:442` — release uses `writer.delete(joinTable, id)` (a soft delete on such a table).
- `:376-391` — `linksOf` reads with `findMany`, which hides soft-deleted links.
- `:448-457` — the re-insert hits the unique pair index and the conflict is swallowed when `pairIsOnlyUnique`.
- `packages/shard-engine/src/do-sql.ts:283` — the unique index has no soft-delete predicate.
- `packages/server/src/schema-through.ts` — `validateThroughRelations` has no soft-delete check (grep for `softdelete` in it returns nothing).
- Fix sketch (preferred, smallest): refuse a `.softDelete()` join table at `defineSchema` in `validateThroughRelations` with a clear error; alpha branch, no compatibility needed. Check codegen/advisor mirrors of that validation and docs.

### 4. Scheduler-dispatch HMAC covers the body only (security) — S–M, MED risk, HIGH confidence on code facts

- `shared/scheduler-dispatch.ts:88-97` — `verifySchedulerDispatch` compares `signCanonical(secret, rawBody)` with the header; no timestamp, no header covered.
- `packages/scheduler/src/scheduler-do.ts:1589-1599` (`signDispatch`) and `:991` — sender signs the body only.
- `packages/runtime/src/create-worker.ts:4092,4179` and `packages/platform-node/src/node-dispatch-route.ts:86,134` — after verification both hosts read `x-lunora-userid` / `x-lunora-identity` from unsigned request headers (`readForwardedDispatchIdentity`).
- `shared/system-dispatch-headers.ts:44,48` — those values go to the shard with `x-lunora-system: 1`.
- `packages/do/src/shard-do.ts:1539` — only replay damper is the mutation-id idempotency row (24 h, only when the body has an `id`).
- Other senders: `@lunora/dispatch` (used by queue/workflow) — find every caller of `signCanonical` / the signature header.
- Existing pattern for a timestamp tolerance: `packages/payment/src/webhook.ts:132-141`.
- Fix sketch: sign a canonical string of version, timestamp, the two forwarded identity values and the body; send the timestamp in a header; refuse outside a tolerance window; retries re-sign with a fresh timestamp. Sender and both receivers change in the same change (alpha: no dual path). Tests: stale signature refused, swapped `x-lunora-userid` refused. Do not include exploit strings in the plan.

### 5. Docs recommend gating `serveStorageObject` on `verifySignedUrl(...).valid` alone (security) — S, LOW risk

- `packages/server/src/http-storage.ts:276-277` — docblock recipe returns only `.valid`.
- `registry/storage/README.md:73` — same recipe in the copy-in registry item.
- `packages/storage/src/signed-url.ts:197-268` — `verifySignedUrl` takes `method` from the query (`:215`) and returns `{ bucketName, contentType, key, method, valid }` for the caller to enforce.
- The hand-written route in the same README (lines ~80-110) and `examples/blog/src/server/index.ts:94-96` do check them.
- Fix sketch: export a small authorizer helper from `@lunora/storage` that returns `true` only when valid, `method === "GET"`, key equals the route's key and the bucket matches; replace both recipes; tests for a PUT-signed URL on GET and a wrong-bucket URL. Public export → `api:check` snapshot update on a fresh build; registry copies → `lint:registry:sync`.

### 6. Client marks a refused subscription "acked"; a later subscriber to the same key gets nothing (bug) — S–M, MED risk, MED confidence

- `packages/client/src/lunora-client.ts:7081` — `sendSubscribeIfOpen` returns early when `state.ack === "acked"`.
- `:7428` + `packages/client/src/subscription.ts:300-304` — on an `error` frame `releaseSubscribeFrame` only resets `"inflight"`.
- `:7495-7503` — `markQueryRejected` then sets `"acked"`.
- `:8375` — a `complete` frame resets to `"idle"` (the two server-ended paths disagree).
- Server side deregisters and sends only an `error` frame: `packages/do/src/shard-do.ts:14980,14878,14907,14922,9776`.
- Comment at `lunora-client.ts:7419-7423`: leaving the registration in place for a later reconnect is intended for the original subscriber.
- Constraint: must not bring back N executions per key (the previous audit's P1 dedupe) or loop on a query that always fails.
- Fix sketch: record the refusal on the state and replay it to late subscribers' `onError`, or reset to `"idle"` so the next `subscribe()` sends exactly one frame.

### 7. `lunoraTest` returns handler results by reference; production wire-encodes them (test fidelity) — S, MED risk

- `packages/server/src/in-process.ts:301` — `runRegisteredFunction` returns `reference.handler(context, args)` as is.
- `packages/testing/src/harness.ts:934-956` — `query`/`mutation`/`action` hand that to the test.
- `packages/do/src/shard-do.ts:510-528` — production runs every dispatch result through `encodeWire`, failing an unencodable one; `:17533` subscription frames send `outcome.result ?? null`.
- `packages/testing/src/fake-scheduler.ts:183-192` — the fake scheduler already round-trips job args.
- Fix sketch: round-trip top-level results through `decodeWire(encodeWire(result))`, mapping encode failures like `encodeDispatchResult`. Expect existing suites that assert `undefined`/identity to change — land on its own; if many unrelated suites break, STOP and report the count.

### 8. Scheduled jobs in the harness get the virtual clock, composed calls do not (test fidelity) — S, LOW risk

- `packages/testing/src/fake-scheduler.ts:339` — context is a spread copy with `now: nowMs`.
- `packages/testing/src/harness.ts:791-793, 819-825` — copied `runQuery`/`runMutation` closures dispatch on the base contexts; `:780-782, 808-810` those read `runClock.getStore() ?? currentNow()`; `:926-932` the scheduled dispatch is not wrapped in `inRun`.
- Fix sketch: run the scheduled dispatch inside `runClock.run(nowMs, …)`; test a TTL check in a composed function after `scheduler.advance`.

### 9. Privacy `restore` rewrites `subjectId` only (bug) — S–M, LOW risk, MED confidence

- `packages/privacy/src/define.ts:330-351` — `restoreSubjects` re-drains datasets, then only `update(request.id, { subjectId: key })`.
- `packages/privacy/src/run.ts:639-681` — `completeErasure` fails open exports, expires ready ones, deletes failed exports' files, moves the erasure to `completed`.
- `packages/privacy/__tests__/restore.test.ts:36-48` — only covers an already-`completed` row.
- Needs a decision on the terminal status of restored requests: recommend mirroring `completeErasure`. If that cannot be reused without a design choice, STOP.

### 10. `restampIdentity` misses offline writes that are mid-replay (bug) — S, LOW risk, MED confidence

- `packages/client/src/offline-queue.ts:419-420` — walks only `this.items`; `:465-489` a flush has already drained the writes it replays.
- `packages/client/src/lunora-client.ts:9859` (live stamp deleted at the gate), `:10208` (transient failure requeues with the old stamp), comment at `:8936-8943`.
- Fix sketch: also cover drained-but-unsettled entries (track drained items by reference).

### 11. A backed-off live query retries only when a later write touches its tables (bug) — M, MED risk, MED confidence (intent)

- `packages/do/src/subscription-backoff.ts:36-40,58` — `retryAt` is only compared, never scheduled.
- `packages/do/src/shard-do.ts:14934-14938` (skipped on flush), `:14767` (only sockets intersecting changed tables are visited).
- `packages/do/__tests__/shard-do.subscription-backoff.test.ts:172-191` — recovery tested only through a later write.
- Must not reintroduce the per-flush re-run storm. Durable Object change → workerd suite. If a clean design needs a new alarm, write the plan as a design decision and mark it BLOCKED (needs owner) instead of executing.

### 12. Seed client records rows as created before `persist` succeeds (bug) — S, LOW risk, HIGH confidence

- `packages/seed/src/client.ts:185-189` (state updated) before `:195-198` (`await persist`); `:172` next call passes `existingIds: idsByTable`.
- Fix sketch: persist first, then commit the three state maps for that table; test with a rejecting `persist`.

### 13. Plans index and agent docs are wrong (docs) — S, LOW risk

- `plans/README.md:38` links `531-typed-live-topics.md`, `:126` links `445-agent-approvals-inbox-design.md`; neither file exists. `plans/529-rls-patchmany-batched-policy-read.md` exists although `:97` records it closed.
- `plans/README.md` "Audit 2026-10-19 — still open" lists "Payment reconcile has no conditional write", but the code has `upsertRevisioned` + `patchIf` (`packages/payment/src/database-store.ts:310-347`, `context.ts:87-92`) — verify, then drop the entry.
- `AGENTS.md:9` says 60 packages / 56 published / 4 internal; the tree has 61 `packages/*/package.json`, 4 private. `AGENTS.md:57,68` say 19 workerd packages; `.github/workflows/test.yml:445` says 21 + one example. Recount at the tip.
- `ROADMAP.md:139,147` list `agent` and `replica` as not verified on workerd though both declare a workerd project; `:58-59` name `jwt-auth`, `privacy`, `saas-ui` as experimental with no table rows. `check-roadmap-tiers` gates ROADMAP — run it.
- This is the plans-index reconcile; the advisor (you) may do the `plans/README.md` part directly, the rest is an executor plan.

### 14. Nightly skips SDK conformance, celld, MySQL and the SaaS e2e (CI) — S, LOW risk

- `.github/workflows/nightly.yml:1-4` says "Everything here runs unfiltered"; jobs are only `test-full`, `test-workerd`, `e2e`, `templates-full` (`:22,61,153,220`).
- `.github/workflows/test.yml` has `sdk-conformance` (`:1046`), `test-celld` (`:503`), `test-mysql` (`:575`), `e2e:saas` (`:718`) with no nightly twin.
- Workflows are JSON-style YAML and are linted by zizmor/actionlint; match the existing job style exactly. Cannot be run locally: verification is lint-only, say so.

### 18. 17 files mix a default export with named exports (tech debt) — S, LOW risk

- e.g. `packages/react/src/use-preloaded-query.ts:132-133`, `packages/react/src/use-paginated-core.ts:458-459`, `packages/studio/src/features/api/api-docs-panel.tsx:406-408`, `packages/nuxt/src/module.ts:242,460`, `packages/cli/src/util/lazy-smoke-load.ts:1209-1210`, `packages/codegen/src/assert-required-packages.ts:198-200`, and ~11 more under `packages/studio/src/features`. Re-derive the list yourself (exclude template-literal false positives in codegen and CLI).
- AGENTS.md: never mix; a default is allowed only as a file's sole export; adapt at the call site when a third party insists on a default (Nuxt module: move helpers to a sibling file). Public exports may change → `api:check`.

### 21. Five small fixes (minor bugs) — S each, LOW risk — one plan, one commit per fix

- `packages/advisor/src/lints/static/duplicate-index.ts:44,60-62` — a non-unique index that exactly duplicates a unique one is reported only if its name sorts later; skip the name tie-break when the covering index is unique.
- `packages/cli/src/commands/eval/handler.ts:222,270` — a `NaN`/missing `average` passes or crashes the table; require a finite `average`, else record a per-eval error.
- `packages/nuxt/src/resolve-tilde-path.ts:17-29` — `@/` and `@@/` are not expanded (treat like `~/` and `~~/`).
- `packages/observability/src/metric-buffer.ts:99` — use `normalizeCapacity` (`log-buffer.ts:50`, used by `span-buffer.ts:108`).
- `packages/agent/src/telemetry/otlp.ts:200-206` — a non-OK OTLP response is dropped silently (comment says "intentionally ignored"); the runtime sink reports it via `reportOtlpRejection` (`packages/runtime/src/otlp-export.ts:463-482`). Report once per streak, do not throw. If this needs a cross-package dependency edge, skip this item and say so.

## PLAN ONLY (write the plan, do not execute — large, needs a decision, or cannot be verified locally)

### 15. Nothing installs the published packages after a release — S–M

- `scripts/clean-machine-smoke.sh:29` ("this script is in no workflow"); `.github/workflows/semantic-release.yml:117-120,187`; `ROADMAP.md` "Next" lists "`lunora init` end-to-end against npm `latest`".

### 16. CI rebuilds the production build cold in ~17 jobs per package PR — M (inferred from workflow structure, not measured)

- `.github/workflows/test.yml:806,864,915,1033` run `pnpm run build:packages:prod`; vis cache only at `:99,247`; `vis.config.ts:26,51-55`.

### 17. 146 file-level `eslint-disable` blocks, 43 re-enabled — M

- `grep -rnE '^/\* eslint-disable ' packages/*/src` = 146; `eslint-enable` = 43. By rule: `no-secrets/no-secrets` 48, `unicorn/prevent-abbreviations` 43, `import/exports-last` 11, `no-restricted-syntax` 9, `sonarjs/deprecation` 7. AGENTS.md: the change belongs in the lint config, reviewed on its own.

### 19. 23 dependencies pinned differently across pnpm catalogs — S

- `pnpm-workspace.yaml` (e.g. `vite` `^8.3.5` in `vite` vs `8.3.2` in `web`; `motion`; `@babel/core`; three are the deliberate `solid2` split); `scripts/check-catalog-drift.js:1-25` does not catch cross-catalog divergence.

### 20. ~200 real-clock sleeps in tests — S for a guard, L for all

- `grep -rnE 'setTimeout\((resolve|r)\b' packages/*/__tests__` = 208; `packages/client/__tests__/cross-tab.test.ts:101` (`delay`, 37 uses; BroadcastChannel needs a real macrotask); `do` and `client` hold about half.

### 22. `shard-do.ts` is 20,326 lines with no split plan — L

- `packages/do/src/shard-do.ts` (class starts `:2235`), `packages/runtime/src/create-worker.ts` 7,229 lines; `plans/135-stable-1.0-roadmap.md:395` defers it; plan 467 is the pattern (for `lunora-client.ts`).

---

# Round two — add-ons and CLI (same commit, `5ed1688b6`)

Not in the execution thread's scope (it works from rows 1–22). "Confirmed" means the advisor opened
the cited code; "as reported" means the audit pass's finding was not re-opened. Several payment rows
rest on Stripe, Polar or better-auth behaviour that could not be checked (the snapshot has no
`node_modules`); those say so.

## CLI and data transfer

### 23. Import failure message promises an idempotent re-run, but rows without `_id` get a fresh id (bug) — S, LOW risk — confirmed

- `packages/cli/src/commands/data-transfer/import.ts:541,544` — both failure paths print "re-run the same command … (existing rows conflict rather than duplicate)".
- `packages/cli/src/commands/data-transfer/import-plan.ts:114-115` — the code's own comment: a row with no `_id` "is written under a fresh one"; only `--mode replace` refuses unkeyed rows (`:116-125`).
- `packages/cli/src/commands/data-transfer/import-rows.ts:79-96,98-132` — `--table` wraps bare documents and NDJSON envelopes without requiring `_id`.
- Impact: an `append`/`upsert` import of unkeyed rows that dies at batch N has committed N-1 batches; the advised re-run inserts them again, reported as `inserted`.
- Fix sketch: the check pass already counts `unkeyed` per table in `SourceIndex`; warn before writing when non-zero and replace the resume advice with "N rows have no `_id`; a re-run duplicates the ones already written".

### 24. Firestore reader changes values it should refuse (bug) — S, LOW risk — confirmed

- `packages/cli/src/commands/data-transfer/sources/firebase.ts:142-144` — `doubleValue` goes through `Number()` with no finiteness check; a non-finite result is emitted as `null` by `JSON.stringify` (`dump-directory.ts:118`).
- `:270` — `{ ...decoded, _id: id }` overwrites a document field named `_id`; the Supabase reader refuses the same collision (`sources/supabase.ts:131-139`).
- Contradicts the stated rule in `sources/reshape.ts:4-8` that a lossy reshape must error. `import-sources.test.ts:426` covers only a finite double.
- Fix sketch: throw with the field path on a non-finite double and when `decoded` already has `_id`.

### 25. Bare Firestore documents carrying `__name__` crash with a raw `TypeError` (bug) — S, LOW risk — confirmed

- `packages/cli/src/commands/data-transfer/sources/firebase.ts:239-243` — a non-wrapped document is decoded whole, including the `__name__` string.
- `:122` — `"nullValue" in value` on a string primitive throws; the comment at `:233-237` says this failure was removed (it was, for the wrapped form only).
- Impact: for `.ndjson` and array-shaped files there is no `fallbackId`, so `__name__` is the only way to carry the id and that path always throws. No test references `__name__`.
- Fix sketch: strip `__name__` before `decodeFields`; make `decodeValue` reject non-object input with the path-named `LunoraError`.

### 26. `sdk generate --source <other repo>` resolves refs against `anolilab/lunora` and stamps that as the source (bug) — S, LOW risk — confirmed for the stamp

- `packages/cli/src/commands/sdk/vendor.ts:244-245` — `attempt` always calls `resolvePinnedSourceRef`, bound to `anolilab/lunora` (`packages/cli/src/util/source-ref.ts:98,216-217`).
- `packages/cli/src/commands/registry/resolve.ts:118-119,133` — the registry path deliberately leaves a custom source unpinned; the SDK path bypasses it by passing a resolved SHA (`vendor.ts:161`).
- `vendor.ts:173` — `source` is hard-coded to the default base and written into `lunora-transport.json` (`:312`).
- Fetch outcome with a fork is read, not executed; `sdk.test.ts` does not exercise `--source`.
- Fix sketch: use `resolveSourceRef` when `source` is set; record `options.source ?? SDK_SOURCE_BASE`.

### 27. SDK regeneration never removes stale files, and the stamp lists whatever is on disk (bug) — M, MED risk — confirmed

- `packages/cli/src/commands/sdk/vendor.ts:128-132` — `cpSync(..., force: true)` overwrites, never deletes; `sdk/handler.ts:110-115` writes generated files the same way.
- `vendor.ts:135` — the stamp's `files` is a walk of the destination, not of what was copied.
- `packages/codegen/src/sdk/targets/dart.ts:485-486,507` — generated files live inside the vendored `lib/`, so a second run stamps them as transport files.
- `vendor.ts:171` — scan-then-copy runs per vendor entry; for two-entry targets (`rust.ts:319-322`, `ruby.ts:289-292`) a refused second entry leaves the first on disk, contrary to the comment at `:83-85`.
- Impact: a transport file removed upstream survives regeneration; Go compiles every `.go` file in the package directory.
- Fix sketch: build the list from the source walk; delete the previous stamp's files that are absent from the new list (only those); run `assertNoSymlinks` over every entry before the first copy.

### 28. Convex directory import follows a symlinked `documents.jsonl` (security) — S, LOW risk — confirmed

- `packages/cli/src/commands/convex-snapshot.ts:99-105` — `stat()` follows links when listing tables; `:146` opens the path with `createReadStream`.
- `:196-205` — blob reads are guarded with `realpath` + containment, explicitly for a crafted export.
- Impact: under the threat model the code already adopts for blobs, an untrusted export can make the importer read a local file outside the snapshot and post it as rows.
- Fix sketch: the same `realpath` + `isInsideDirectory` check for each table directory and its `documents.jsonl`, with a test beside `convex-snapshot.test.ts`.

### 29. `cloudflare ai-gateway` writes only top-level `vars` and takes no `--env` (bug) — S–M, LOW risk — confirmed in code, wrangler behaviour not re-checked

- `packages/cli/src/commands/cloudflare/ai-gateway/handler.ts:142` — writes `["vars", key]` only (`:277-281`, `:311`).
- `packages/cli/src/commands/cloudflare/index.ts:121` — `--env` is declared for containers / deployments / profile, not ai-gateway.
- Impact: a Worker deployed with `--env <name>` never sees `LUNORA_AI_GATEWAY_ID` (wrangler `vars` are not inherited by environments — verify against wrangler docs before planning).
- Fix sketch: accept `--env` and write `env.<name>.vars`; without it, warn when the config has an `env` block.

### 30. `lunora analyze` counts every output file and matches `_generated` by path (bug) — M, LOW risk — confirmed in code, not run

- `packages/cli/src/commands/analyze/handler.ts:82-94` — total and "top modules" are every file under the wrangler `--outdir` (`:142`), source maps included; `:86` matches `_generated` by path substring.
- `packages/cli/__tests__/commands/analyze.test.ts:39-43` — pinned only against a hand-built fixture.
- Fix sketch: exclude `.map` and non-module files; derive per-module and `_generated` sizes from the bundle metafile or source map.

### 31. `append` imports build two id sets and parse each row three times though no plan reads them (perf) — S, LOW risk — as reported, unmeasured

- `packages/cli/src/commands/data-transfer/import.ts:1190,1246-1247,1292-1299`; `import-plan.ts:50-87`.
- Fix sketch: pass an index only when the mode plans or prunes; keep `unkeyed` as a counter (row 23 needs it).

### Investigate only (LOW confidence, not confirmed)

- Convex importer ignores the export's type sidecar: `packages/cli/src/commands/data-transfer/import-source.ts:44-58`; `generated_schema` is referenced nowhere. May matter for int64 and bytes fields — check against a real export.
- `alerts setup` reads one page of notification policies: `packages/cli/src/commands/cloudflare/alerts/handler.ts:71-75`, ownership decided at `alerts/plan.ts:312`; the paginating `notificationsList` (`api.ts:239-250`) is used only for history. Could create duplicate policies on large accounts.

### Minor, noted

- `sources/reshape.ts:48,125` — a date-only value under a `timestamp-*` reshape fails with a misleading "not a date" (loud, not silent).
- `cloudflare/profile/handler.ts:183-184` — `--env` ignores a per-environment `account_id`.
- `data-transfer/export.ts:169-173` — a truncated export to stdout says "nothing was kept" after rows were emitted (exit code still non-zero).
- `migrate d1-to-hyperdrive` without `--tables`: the log line "Exporting .global() data" and the "counts match" total are misleading when shard-local rows are copied (the copy itself is documented at `migrate/index.ts:49`).

## Auth

### 32. Auth jurisdiction copy can never finish with 17 or more tables (bug) — S, LOW risk — confirmed

- `packages/auth/src/jurisdiction-move.ts:82` — `MAX_PAGES_PER_CALL = 16`.
- `:847-861` — every table spends one page of the per-call budget on a source read before the "already done, nothing new" break, so finished tables are re-probed on every call; at the 17th table the loop returns `{ done: false }`.
- `:187-190` — the table set is every non-reserved table, including audit and rate-limit tables.
- Impact: tables 17+ are never copied, the fingerprint step (`:884-892`) is never reached, `purge` refuses forever. At exactly 16 tables the last one advances one page per call. No test uses more than 16 tables.
- Fix sketch: skip tables whose marker is `done` without charging the budget, or batch the "any new rows" probe into one status call; test with 17+ tables. Durable Object change → workerd move suite.

### 35. `removeMember` and `updateMemberRole` skip the last-owner guard (bug) — S, LOW risk — confirmed

- `packages/auth/src/admin.ts:557-586,1235-1237` — `removeUser` refuses to orphan an organization.
- `:1218-1221` — `removeMember` deletes the row unconditionally and leaves the user's `teamMember` rows.
- `:943-955` — `updateMemberRole` can demote the only owner.
- Tests cover the guard only for `removeUser` (`__tests__/admin.behaviour.test.ts:370-393`).
- Fix sketch: reuse the roster check in both; delete the member's `teamMember` rows for that organization's teams.

### 38. Email-domain gate runs on user creation only (security) — S, LOW risk — confirmed

- `packages/auth/src/email-gate.ts:106-110,122-147` — installs only `databaseHooks.user.create.before`.
- Impact: with better-auth's change-email enabled (opt-in upstream), a user can switch to a denied or disposable domain after sign-up.
- Fix sketch: a `user.update.before` hook that runs `assertEmailAllowed` when the patch carries `email`.

### 42. Audit hook maps a fixed path list (security) — S–M, LOW risk — as reported; plugin paths were listed from memory

- `packages/auth/src/audit-hooks.ts:128-191` — `eventForPath` matches a fixed list; anything else writes nothing.
- `packages/auth/src/plugins.ts:120,138,142,154,156,157` — re-exports `passkey`, `oneTap`, `admin`, `oneTimeToken`, `phoneNumber`, `siwe`, whose completion endpoints match no branch.
- Impact: those sign-ins and admin-plugin impersonation/ban/role/password changes, `/delete-user`, `/change-email` leave no audit row; the file's own comment (`:109-112`) calls that asymmetry worse than either gap.
- Fix sketch: add branches with new event names; a test that enumerates installed plugin endpoints and fails on an unmapped session-issuing path.

### 43. Invite-only admits any non-password sign-up whose email has a pending invitation (security) — S, MED risk — as reported; investigate first

- `packages/auth/src/invite-only.ts:482` — the token is checked only on `/sign-up/email`; `:494-510` the `user.create.before` gate admits by email without reading `emailVerified`; `:50-55` assumes an OAuth callback "carries a provider-verified email".
- Depends on better-auth creating new OAuth users with an unverified email for some providers.
- Fix sketch: admit a non-`/sign-up/email` creation only when `user.emailVerified === true`.

## Payments

### 33. Payment facade has no `updateSubscription` / `resumeSubscription`; docs send apps to the raw adapter (security) — M, LOW risk — confirmed

- `packages/payment/src/create-payment.ts:131-185` — facade has `cancelSubscription` (authorized at `:352-366`) only; a grep for the two names in the file returns nothing.
- `packages/payment/docs/index.mdx:275-280` — docs point at `ctx.payments.adapter` for those two; `packages/payment/docs/creem.mdx:245,259,268` show `ctx.payments.adapter.updateSubscription(subscriptionId, …)`.
- `packages/payment/src/providers/stripe.ts:632-652`, `providers/polar.ts:471-506` — adapter methods take a bare subscription id with no `authorize` call and no store write.
- Impact: the documented plan/seat-change path has no per-caller ownership check; also a one-way door (period-end cancel is on the facade, its undo is not).
- Fix sketch: facade methods that load the stored row, `ensureAuthorized(existing.referenceId)`, call the adapter, upsert via `overlayProviderSubscription`; extend the docs warning. Public surface → `api:check`, docs.

### 34. Same-state subscription events are rejected before the field merge (bug) — S, LOW risk — confirmed

- `packages/payment/src/state-machine.ts:52-53` — `past_due` has no `mark_past_due` edge, `paused` has no `pause` edge; `active` has a `renew` self-loop.
- `packages/payment/src/sync.ts:483-489` — a missing edge returns `illegal_transition` before the merge at `:491`, so period, price, quantity, `cancelAtPeriodEnd` and `lastEventAt` are skipped.
- `packages/payment/src/providers/stripe.ts:363-384` — every `customer.subscription.updated` is typed by status.
- Impact: while past-due or paused, later updates are 200-acked and dropped; because `lastEventAt` does not advance, a delayed older `active` event can pass the staleness check (`sync.ts:401-413`).
- Fix sketch: add the two self-loops, or apply the field merge whenever target state equals current state. Stateful → property test per `.agents/docs/testing.md`.

### 36. Polar checkout ignores `quantity` (bug) — S, LOW risk — omission confirmed; Polar's seat parameter not verified

- `packages/payment/src/providers/polar.ts:294-308` — `checkouts.create` never reads `input.quantity`; Stripe sends it (`providers/stripe.ts:470`); the facade includes it in the idempotency key (`create-payment.ts:256`).
- Fix sketch: map to Polar's seat field, or throw `PROVIDER_ERROR` for `quantity > 1` as the adapter does for other unsupported combinations (`:476-478`).

### 37. Stripe usage is sent with an empty customer id and then marked reported (bug) — M, LOW risk — code confirmed; Stripe's handling not verified

- `packages/payment/src/create-payment.ts:696-705` — `track` passes `customer?.id` then marks the row reported.
- `packages/payment/src/providers/stripe.ts:610` — sends `stripe_customer_id: input.customerId ?? ""`.
- `create-payment.ts:247` — the only place a customer row is written; `sync.ts` never persists `customerId`.
- Fix sketch: persist the provider customer from verified webhook actions; in `track`, skip the forward and leave the row unreported when no customer exists.

### 39. Setup-mode Stripe Checkout is recorded as a captured payment (bug) — S, LOW risk — confirmed

- `packages/payment/src/providers/stripe.ts:230,242-271` — only `mode === "subscription"` is separated; a session with no payment intent and `no_payment_required` becomes `payment.captured` with no amount. The facade only creates `payment` and `subscription` (`types.ts:157`), so this needs a setup session created elsewhere in the account.
- Fix sketch: return `unhandled` unless `mode === "payment"` before the free-order branch.

### 40. Derived checkout idempotency key repeats for an identical second checkout (bug) — S, MED risk — as reported; rests on Stripe's replay behaviour

- `packages/payment/src/create-payment.ts:253-262` (key is a pure function of reference, price, mode, quantity, URLs, metadata); `providers/stripe.ts:480`; `__tests__/create-payment.test.ts:164-172`.
- Fix sketch: add a time bucket or caller nonce, or detect a replayed non-open session and retry with a fresh key (a fully random key loses double-click protection).

### 41. A replayed refund returns the unchanged session with no signal (bug) — S, LOW risk — as reported; rests on Stripe's replay behaviour

- `packages/payment/src/create-payment.ts:581,606-608`; `__tests__/create-payment.test.ts:688-713` pins that the ledger is not inflated, not what the caller sees.
- Fix sketch: typed error or `replayed` marker; fold the stored refunded total into the derived key.

### Pre-existing observation, not counted

- The min/max aggregate companion on D1 writes an absolute `__count__` from an earlier read (`packages/sql-store/src/ctx-db.ts:2497-2518`), which can lose a concurrent decrement. Identical at the previous audit's commit.

## Advisor lints

Most rule bodies in `packages/advisor/src/lints/static/*` are thin filters over evidence arrays; the
matchers live in `packages/codegen/src/discover/*` and `packages/codegen/src/argument-taint.ts`, which
is where the defects sit. Registry check: 114 static lints registered, 114 lint files, no duplicate
ids. Rows 44–47 and 55 confirmed by the advisor; the rest as reported. Nothing was executed. Widening
a matcher surfaces new findings in existing apps, and the deploy gate blocks on ERROR, so each of
these needs a rollout note.

### 44. Identity-write and user-table feeders miss the facade write form `ctx.db.<table>.<write>(…)` (security-lint false negative) — M, MED risk — confirmed

- `packages/codegen/src/discover/owner-field-writes/index.ts:44,60` — the sink is `insert|insertManyUnsafe|patch|replace` on a receiver that must denote exactly `ctx.db` (`discover/context-root.ts:355`), so `ctx.db.posts.insert({ userId: args.userId })` is never a sink.
- `packages/codegen/src/discover/table-writes.ts:25` (`FACADE_WRITES`) and `packages/server/src/facade.ts:140` — the facade form is a real write surface; `database-calls.ts:41` calls it "the form real app code writes".
- `packages/codegen/src/discover/procedure-middleware.ts:232-240` (`isUserTableInsert`), `discover/inserts.ts:17`, `discover/mutator-writes.ts:22` — same table-argument-only shape.
- Silent rules: `owner_field_from_args_not_auth` (ERROR), `user_creating_mutation_without_captcha`, `signup_mutation_without_disposable_gating`, `mutator_full_row_replace`. Opposite direction: `table_without_insert` (`packages/advisor/src/lints/static/table-without-insert.ts:41`) reports "no insert path" for tables written only through the facade, `insertMany` or `upsert`.
- Fix sketch: one shared write-target resolver (as `readTargetOf` does for reads) returning `{ table, documentArgument, method }` for both forms; use it in the four feeders; feed `table_without_insert` from `tableWrites` too.

### 45. The shared taint predicate does not follow locally destructured or composed `args` (security-lint false negative) — M, MED risk — confirmed

- `packages/codegen/src/argument-taint.ts:196` — `singleHopInitializer` returns `undefined` unless the sink expression is a bare identifier, so a template or member access built from a local (`const host = args.host; … \`https://${host}/x\``) is not argument-derived.
- `:221` — the hop matches `variable.getName() !== name`; for `const { url } = args` the declaration's name is the pattern text, so a body-level destructure never matches.
- `:243-250` — `isArgumentDerived` is only those two checks; `packages/codegen/__tests__/argument-taint.test.ts:84-121` covers parameter destructuring and the bare-identifier hop only.
- Consumers: `discover/argument-derived-accesses.ts:45`, `argument-derived-fetches.ts:24`, `mail-recipient-accesses.ts:57,66`, `image-delivery-url-accesses.ts:29`, `ai-raw-runs.ts:46`, `soft-delete-reads.ts:49`, `owner-field-writes/index.ts:186`.
- Silent rules on those shapes: `action_fetch_ssrf`, `kv_unscoped_user_key_idor`, `storage_key_from_user_args`, `container_instance_key_from_user_input`, `browser_user_url_without_allowlist`, `mail_recipient_from_request_input`, `images_url_source_from_user_input`, `ai_raw_run_escape_hatch`, `soft_delete_include_deleted_from_args`, `owner_field_from_args_not_auth`.
- The request-rooted twin already handles the member-root case (`isRequestInputDerived`, `:353-359`). Mind the shadowing note at `:207-213`.
- Fix sketch: apply the one-hop lookup to every value identifier in the expression and let it match binding elements of a destructuring declaration; add both shapes to the test.

### 46. RLS is not detected when the middleware or the policy list is not written inline (lint false negative and false positive) — M, MED risk — confirmed

- `packages/codegen/src/discover/builder-chain.ts:65` — `wrappedCallsWhere` only accepts a `.use(<call>)` argument, so `const ownRead = rls(ownNotes); query.use(ownRead)` yields `usesRls: false`. That is the shape in `examples/clerk-auth/lunora/notes.ts:37-48` and `apps/playground/lunora/notes.ts:37`.
- `packages/codegen/src/discover/rls-procedures/index.ts:22` — `extractPolicyTables` returns `[]` unless `rls()`'s first argument is an array literal of object literals; the documented form is `rls(definePolicies([...]))` (`apps/docs/src/content/docs/concepts/rls.mdx:25`).
- `packages/advisor/src/lints/static/rls-uncovered-table.ts:68` returns nothing when no policy table was extracted; `privileged-dispatch-unvalidated-payload.ts:59-62` and `codegen/src/discover/normalize-id-authorization.ts:254` read the same `usesRls`.
- Impact: `rls_uncovered_table` never fires for policies written the documented way; `privileged_dispatch_unvalidated_payload` (ERROR) misses aliased targets; `normalize_id_used_as_authorization` flags procedures that are RLS-protected through an alias. `procedure-middleware.ts:151-164` already resolves a same-file `const` alias for `rateLimit`.
- Fix sketch: resolve a `.use(identifier)` argument to its `const` initializer in `wrappedCallsWhere`; unwrap `definePolicies(...)` and follow `definePolicy({ table })` and same-file consts in `extractPolicyTables`.

### 47. `sql_injection_risk` only sees string building written inline as the first argument (security-lint false negative) — S–M, LOW risk — confirmed

- `packages/codegen/src/discover/sql-interpolation.ts:35,45` — the only flagged shape is a `BinaryExpression` or `TemplateExpression` directly as argument 0 of `ctx.sql.query` / `.unsafe`.
- `packages/advisor/src/lints/static/sql-injection-risk.ts:22-23` — the description says "tagged-template", while `sql-interpolation.ts:12-18` states `ctx.sql` is not a tagged template.
- Missed: SQL text built in a `const` first, a raw argument passed as the text, a joined array, a cast or parenthesised concatenation. Flagged wrongly: a template that only interpolates a module constant.
- Fix sketch: unwrap parentheses and casts, follow one `const` hop, treat any non-literal argument-derived `text` as a finding; reword the description to the `query(text, params)` sink.

### 48. A rate limit (or RLS, captcha, mask) on a shared base builder reads as absent (lint false positive) — M, LOW risk — as reported

- `packages/codegen/src/discover/procedure-middleware.ts:203` — `protectionsInChain` walks only call expressions and stops at an identifier root; `:887` passes whatever sits left of the terminal; `discover/functions/classify-procedure-call.ts:228-238` classifies `base.mutation(h)` as public with the identifier as receiver.
- Impact: with `const guarded = mutation.use(rateLimit(...))`, every `guarded.mutation(...)` gets false `public_mutation_without_ratelimit`, `privileged_fanout_from_public_procedure`, `user_creating_mutation_without_captcha`; compounds row 46.
- Fix sketch: when the chain root is an identifier bound to a `const`, continue into its initializer (bounded hops) in `walkBuilderChain` so every chain reader agrees.

### 49. `privileged_dispatch_unvalidated_payload` tracks one loop spelling (security-lint false negative) — M, LOW risk — as reported

- `packages/codegen/src/discover/privileged-dispatches.ts:62-66,149,236` — context and batch parameters must be plain identifiers; `:155-167` a message binding is learned only from `for (const m of batch.messages)`; `:54` the handler must be an inline arrow or function expression.
- Fix sketch: accept destructured parameters, treat the first parameter of an iteration callback over `<batch>.messages` as a message binding, resolve the handler with `memberFunctionOf` (`context-root.ts`).

### 50. Any `ctx.*` reference in a key counts as server-side scoping (security-lint false negative) — S–M, MED risk — as reported

- `packages/codegen/src/argument-taint.ts:299-302` — `isScopedByContext` is true when the key contains any identifier denoting the ctx or a surface of it (`discover/context-root.ts:436-440`); it suppresses findings at `argument-derived-accesses.ts:45`, `mail-recipient-accesses.ts:57,66`, `image-delivery-url-accesses.ts:29`.
- Impact: a key composed from an environment prefix or `ctx.now` plus a caller-supplied part is treated as identity-scoped, silencing `kv_unscoped_user_key_idor` and `storage_key_from_user_args`. The owner-field feeder already uses the stricter `isContextRooted` (`owner-field-writes/index.ts:176-186`).
- Fix sketch: restrict the suppressor to identity paths (`ctx.auth.*`, `ctx.identity.*` and values derived from them), required as a prefix of the composed key.

### 51. `index_utilization` reports indexes that can never record a read as dead (runtime-lint false positive) — M, LOW risk — as reported

- `packages/shard-engine/src/ctx-db.ts:189` — `IndexUseHook` has no `"vector"` kind (stamps only at `:1640,1660,1677,4872,5032,5051`); `:4869` a `.global()` rank read returns before the stamp.
- `packages/codegen/src/emit/shard-metadata.ts:98,110` — declared indexes handed to the Studio include vector and `unique: true` indexes; `packages/studio/src/features/advisors/derive-runtime-advisories.ts:125-128` reconciles all of them; `insights-panel.tsx:171,180` reads one shard's metrics although `packages/advisor/src/lints/runtime/index-utilization.ts:24` says per-shard arrays are summed.
- Impact: every vector index is reported as "dead overhead… drop it"; likewise a unique index kept only for its constraint (following the remediation drops the constraint), rank indexes on `.global()` tables, and indexes used only on other shards. HIGH for vector and global rank, MED for the other two.
- Fix sketch: exclude kinds the runtime cannot stamp and `unique` indexes (or stamp them); aggregate across shards or say "on this shard".

### 52. Shorthand `includeDeleted` is not read (lint false negative) — S, LOW risk — as reported

- `packages/codegen/src/discover/ast.ts:539` — `propertyInitializer` returns `undefined` for a shorthand property; `discover/soft-delete-reads.ts:42-46` skips the read then. The feeder also walks only exported procedure declarations.
- Fix sketch: use the shorthand's name node as the value (as `mail-recipient-accesses.ts:55-58` does); move the walk to `collectCallRows` with call-site scope.

### 53. Expiry and tolerance thresholds are read from plain numeric literals only (lint false negative) — S, LOW risk — as reported

- `packages/codegen/src/discover/storage-uploads.ts:28` — `expiresInSeconds` only from a numeric literal; `storage-presigned-url-for-private-content.ts` (`isNearExpiryCeiling`) treats `undefined` as fine, so the usual `7 * 24 * 60 * 60` spelling is never flagged.
- `packages/advisor/src/lints/static/payment-webhook-wide-tolerance.ts:47` — compares `>=` one hour while the description says "over an hour" (the payment feeder's literal handling was not read).
- Fix sketch: fold numeric `*`/`+` of literals in a shared helper; align the comparison with the description.

### 54. `browser_user_url_without_allowlist` is suppressed globally by any one allowlist (lint false negative) — S–M, LOW risk — as reported, MED confidence

- `packages/advisor/src/lints/static/browser-user-url-without-allowlist.ts:60-61` — all findings are withheld when any `createBrowser` call has an `allowedHosts` key present; `codegen/src/discover/config-calls.ts` (`keysFromObjectLiteral`) records presence, not value. What an empty `allowedHosts` means at runtime was not checked.
- Fix sketch: suppress only when every analyzable `createBrowser` call carries a non-empty literal allowlist, or reword the description.

### 55. `runAdvisor` does not isolate a throwing lint (hardening) — S, LOW risk — confirmed; no lint found that throws today

- `packages/advisor/src/index.ts:491` — `findings.push(...lint.run(context))` with no guard; called inline from `packages/codegen/src/run-codegen.ts:602`.
- Impact: one throwing lint ends the whole run in dev watch and the deploy preflight.
- Fix sketch: catch per lint and emit one `advisor_lint_failed` finding naming the lint.

### 56. "Outside action" feeders see only inline exported handlers (lint false negative) — M, LOW risk — as reported, MED confidence

- `packages/codegen/src/discover/context-property-calls.ts:76` — only exported declarations and the inline handler from `handlerOf` (`discover/ast.ts:499-523`) are walked, so `hyperdrive_outside_action` and `r2sql_outside_action` miss `ctx.sql` / `ctx.r2sql` in a helper or a separately declared handler. Whether the type system already rejects passing a query ctx to such a helper was not checked.
- Fix sketch: build on `collectCallRows` + `callSiteScopeOf` and keep rows whose callers include a query or mutation.

### Advisor: open question and not reached

- `hot_shard`: unconfirmed whether the root Durable Object is in the ungrouped traffic feed; if so a busy root would be reported as a hot shard.
- Not opened: the `container-*` (7), `auth-*` config (6), `workflow-*` (3), `shape-*` (2), `external-source-*` (3), `geo-index-*` (2) rules and about 15 others; feeders `secrets.ts`, `argument-validators.ts`, `http-action-guards.ts`, `http-header-writes.ts`, `ratelimit-key-selectors.ts`, `fail-open-guards.ts`, `identity-claim-reads.ts`, `unrestricted-where-branches.ts`, `vector-namespace-accesses.ts`, `call-edges.ts`, `payment-webhooks.ts`. Tests were not audited for "passes with the lint body deleted".
- Read and found sound: about 45 rule bodies (including `public_arg_uses_any`, `hardcoded_secret`, `admin_route_without_guard`, `payment_create_without_authorize`, `http_action_missing_auth_guard`, `dispatch_cycle`, `nondeterministic_query_mutation`, `hot_shard`, `fan_out_breadth`) and the shared `lints/{argument-derived-sink,graph,sweeps,helpers}.ts`.

---

# Direction options (for the maintainer to weigh, not ranked against bugs)

- **Default HTTP and socket transports in the seven non-Python SDKs.** `sdks/README.md:156,183-189`; `sdks/smoke/<lang>/` is hand-written wiring. M per language; each pulls in a WebSocket dependency.
- **`registry status` and `registry remove`.** `packages/cli/src/commands/registry/handler.ts:17-63` has `add`/`list`/`view`/`build` only; `packages/cli/src/util/registry-lock.ts:28-33` already records a per-file hash; `registry/reconcile.ts:1-8` does a 3-way upgrade. S for `status`, M for `remove`.
- **Operational MCP tools.** 18 tools, 15 read-only; routes exist (`packages/runtime/src/scheduled-admin-routes.ts:23-24`, `workflows-admin-routes.ts:32-34`, `backup-admin-routes.ts:17-20`) and `packages/mcp/src/write-confirmation.ts:1-25` provides digest-bound confirmation. M; adds write surface that needs scopes.
- **Decide the rspack gap before graduation.** `packages/rspack/README.md:119-122`; two templates ship on it; `plans/463-experimental-graduation.md:31,73`. Write the parity table as port / won't port / blocked upstream.

# Considered and rejected

- `.js` relative imports in examples and templates (176 outside codegen, none in `packages/*/src`): possibly deliberate under `lunora/` directories consumed under NodeNext.
- Gating the fallow dead-code check (`fallow:dead-code` runs in no workflow; `lint.yml:178-183` is `continue-on-error`): a decision with unknown backlog.
- Adapter duplication (`voice-audio.ts` near-identical in five adapters): already plan 160.
- Agent OTLP "unread body / no timeout" on the runtime sink (`packages/runtime/src/otlp-export.ts:518-536`): LOW confidence, not reproduced.

# Checked and found sound

- **Internal header trust:** RPC/REST/batch build shard headers from scratch (`runtime/src/create-worker.ts:2440-2520`); every upgrade path strips client `x-lunora-*` (`:2840-2900`); `voice-do.ts:208-210` is reached only through that strip; `x-lunora-client-ip` only from `cf-connecting-ip` or an operator-declared header.
- **jwt-auth, cloudflare-access:** asymmetric algorithms only, `exp` required, https-only JWKS with issuer match, Access admin gate requires `aud`.
- **Token comparisons:** admin bearer, session-DO secret, auth-DO secret, admin signal, webhook signatures all constant-time or `subtle.verify`.
- **MCP:** every gated family omitted from the list and refused at dispatch; scopes only narrow.
- **Admin routes and admin RPC:** every `*-admin-routes.ts` handler reaches an admin assert; `ShardDO.adminCaller` fails closed without a token.
- **Studio host:** loopback/Host/forwarded-header guard, fetch-metadata/Origin check, JSON content-type before body read, fixed or identifier-validated write paths.
- **CLI `registry add` / `init`:** validated names, schemes and refs, branches pinned to a commit, traversal and symlinks refused.
- **Privacy** apart from row 9; **values** validators (`v.ts`, `validator-map.ts`); **platform-celld** (thin recomposition); **astro**, **nuxt** apart from row 21.
- **Core since the last audit:** many-to-many load and `_count`, bounded cascade, `readBatchMatches`, `socket-table-index.ts`, ratelimit sweeps, `writeWithCompanions`, scheduler lease/pool/dead-letter, `ws-bearer-protocol.ts`, the revision-guarded payment reconcile, the agent B5 fix.
- **Data transfer:** batcher ceilings and 207 handling, `--mode replace` ordering, end-marker checks, export file handling (0600, rename), blob migration (hash keys, digest checks, containment), Supabase reader.
- **Auth storage adapter and session resolution:** quoted identifiers and bound values, single-statement consume/increment, internal routes fail closed, org/team claims re-checked per resolution, cookie defaults, Turnstile fails closed.
- **Payment:** refund folding and over-refund guard, `money.ts`, `entitlements.ts`, raw-body signature verification for Stripe/Polar/Creem/Dodo, reference id pinned last in metadata, ownership checks on refund/capture/cancel/portal.
- **Repo hygiene:** every AGENTS.md command exists; no `it.only`; zero `@ts-expect-error` in `packages/*/src`; no package cycles; 873 documented `@lunora/*` imports resolve; no committed credentials found (test fixtures only).

# Not audited

- **Core:** most of `packages/do/src/shard-do.ts` (lazy function loading, write-frame batching, socket re-auth, live-topic routes), `create-worker.ts`, `rls/middleware.ts`, `query-coordinator.ts`, all codegen emitters, `shard-engine` `introspect.ts` (second half), `replica.ts`, `admin-export-import.ts`, `ctx-db-migrations.ts`, `ttl-sweep.ts`, client `http-stream.ts`, `cross-tab.ts`, `tab-leadership.ts`.
- **Add-ons:** `providers/autumn.ts`, most of `creem.ts` / `dodopayments.ts`, `agent/src/component.ts` and `agent-loop.ts`, `notify` inbox and D1 store, `x402` beyond config, `saas-ui`, `cimd-workers.ts` response-size limits.
- **CLI:** `alerts/products.ts`, `alerts/status.ts`, `zip-entry-stream.ts`, `util/spawn.ts`.
- **Other:** `seed` plan/generators, `testing` agent harness and fakes, `values` JSON-schema emitters, Studio and e2e spec quality, vite/rspack duplication.
- **Dependencies:** upstream version lag, whether the four `patches/` or the two `auditConfig.ignoreGhsas` entries are fixed upstream; `pnpm audit` was not re-run.
- **Measurements:** nothing was built, run or benchmarked; CI cost (row 16) is inferred from workflow structure.
