# Plan 462 — Durable Object class budget: warn near the account cap, opt in to one merged class

**Baseline:** `origin/alpha` (2026-10-06)
**Status:** DONE (pending review on `feat/do-class-budget`)

## 0. Headline finding

Cloudflare caps Durable Object classes at **100 per account on Workers Free and
500 on Workers Paid** (developers.cloudflare.com/durable-objects/platform/limits).
Every Lunora app spends up to three of them on framework classes (`ShardDO`,
`SchedulerDO` with a scheduler, `ShardRegistryDO` with `.shardBy()` tables), plus
one per container and voice agent, and every environment is its own Worker with
its own namespaces. A Free account fits roughly ten to twenty app-environments.
Nothing in Lunora knows the cap exists: `lunora deploy` would simply fail there.

## 1. Current state (audit)

- Framework classes and bindings: `packages/config/src/worker-entry.ts:105`
  (`DURABLE_OBJECT_BINDINGS`). `SessionDO` is never composed in (`:151-165`).
- Conditional classes: `SchedulerDO` off `studioFeatures.scheduler`
  (`packages/codegen/src/run-codegen.ts:1039`); `ShardRegistryDO` off `.shardBy()`
  tables (`packages/codegen/src/emit/runtime-modules.ts:80`).
- The class-A entry is composed by `@lunora/vite`
  (`packages/vite/src/framework-compose-plugin.ts:165-251`), keyed off which
  `_generated/` class modules exist (`:329`).
- Every stub is NAMED: shards by client-supplied key through `resolveShard`
  (`packages/runtime/src/resolve-shard.ts:222`), the scheduler as `"default"` /
  `schedulerInstanceName`, the registry as `"__lunora_shard_registry__"`. No
  framework code uses `newUniqueId` or `idFromString`.
- None of the four classes uses RPC or class identity; all speak HTTP routes plus
  `alarm` / `webSocket*` handlers. `ShardDO` reads `ctx.id.name`
  (`packages/platform-cloudflare/src/cloudflare-host.ts:240`).
- No Cloudflare API client in `deploy` or `doctor`; `ai/handler.ts` is the
  token/account resolution pattern (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  or wrangler `account_id`, injectable `fetch`).
- Wrangler migrations: reconcile only ever appends `new_sqlite_classes`;
  nothing writes `renamed_classes` / `deleted_classes`.

## 2. Existing seams (do not reinvent)

- "Module existence is the signal": codegen writes `_generated/scheduler.ts` /
  `shardRegistry.ts`, and the Vite entry, the builder and binding inference all
  key off the file. The merged mode adds one more such module.
- `readProjectConfigLiterals` (`packages/codegen/src/project-config-file.ts`) for
  a literal `lunora.config` opt-in.
- `DOCTOR_CODES` + the docs table in `packages/cli/docs/index.mdx`.

## 3. The behavioural contract to preserve

- An app that does not opt in produces byte-identical generated output, entry and
  wrangler config.
- No data moves: the merged mode is for apps whose `SHARD` binding has never been
  deployed against `ShardDO`. An existing app that flips the flag gets a doctor
  FAIL, not a silent class swap that would orphan its shard data.

## 4. Design decisions

- **Route by role-prefixed instance name, not by binding.** All bindings that
  share a class share one namespace, so the scheduler's `"default"` and the
  registry's name would collide with client-chosen shard keys. Scheduler and
  registry stubs go through `roleNamespace(env.SHARD, role)`, which prefixes the
  name with `__lunora_do__:<role>:`; the merged class reads `ctx.id.name` once in
  its constructor and instantiates that role's class. Anything unprefixed is a
  shard. `resolveShard` rejects client shard keys carrying the reserved prefix, so
  a client cannot address the scheduler. Rejected: pinning a role in storage on
  first contact (claydo's approach) — it needs async storage in the constructor
  and still cannot stop a shard key from colliding with a scheduler name.
- **One binding, `SHARD`, bound to `LunoraDO`.** `SCHEDULER` and
  `SHARD_REGISTRY` disappear from wrangler in merged mode; the entry passes
  role namespaces derived from `env.SHARD`. Rejected: keeping all three bindings
  pointed at one class — any code reading `env.SCHEDULER` directly would bypass
  the prefix and land on a shard.
- **Composition, not facets.** Lunora writes all three classes, so a plain
  delegating class is enough: each role keeps the instance's own SQLite storage,
  alarm and WebSockets, because one instance only ever plays one role. Rejected:
  claydo-style facets — an extra hop per call, a multiplexed alarm, and no
  equivalent on celld/node.
- **Opt-in literal `durableObjects: { merge: true }` in `lunora.config`.**
  Codegen reads it and writes `_generated/durableObjects.ts`; everything
  downstream keys off that file. A hand-written entry opts in by exporting
  `LunoraDO` (built with `mergeDurableObjects`) — binding inference maps that
  export to `SHARD` and drops the per-role classes.
- **Budget check is advisory and online-only.** `doctor` and `deploy` call
  `GET /accounts/{id}/workers/durable_objects/namespaces` only when
  `CLOUDFLARE_API_TOKEN` and an account id are present; the plan tier is not
  exposed, so the message names both caps. Warn at 90% of a cap, fail at the
  Paid cap.

## 5. Workstreams

1. **Budget check (S). Done.** `cli/src/util/durable-object-budget.ts`, doctor codes
   `do-class-budget-ok` / `do-class-budget-near` / `do-class-budget-unchecked`,
   a warning in `deploy` before wrangler runs.
2. **Reserved role names (S). Done.** `LUNORA_ROLE_PREFIX` in `@lunora/shard-engine`;
   `resolveShard` rejects shard keys carrying it.
3. **Merged class (M). Done.** `mergeDurableObjects` + `roleNamespace` in `@lunora/do`.
4. **Codegen + entry + inference (M). Done** — the doctor FAIL landed as the export validator's error (what `verify`/`doctor` already run) with a merge-specific remedy, rather than a new doctor code. Config literal, `_generated/durableObjects.ts`,
   the merged Vite entry, `LunoraDO` in binding inference, reconcile de-duplication,
   a doctor FAIL when `SHARD` is still bound to `ShardDO`.
5. **Docs (S). Done.** Deployment page section; doctor table rows.

## 6. Platform parity

Not a `ctx.*` surface or a binding; it changes how the existing three classes are
packaged.

| Feature                 | `cloudflare` | `celld`     | `node`      | Notes                                                                                                                                                                    |
| ----------------------- | ------------ | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merged framework class  | native       | native      | unsupported | celld runs the wrangler `durable_objects` as declared (new apps only — it refuses rename/delete). Node hosts never instantiate these classes; the flag is ignored there. |
| Account class-cap check | native       | unsupported | unsupported | Cloudflare account limit; other hosts have no such cap.                                                                                                                  |

## 7. Phasing & ordering

| Phase | Work            | Gate                                                                       |
| ----- | --------------- | -------------------------------------------------------------------------- |
| 1     | Workstream 1    | cli doctor/deploy tests; docs table assertion                              |
| 2     | Workstreams 2–3 | runtime + do unit tests (role dispatch, reserved-key rejection)            |
| 3     | Workstream 4    | codegen/vite/config tests; golden fixtures byte-identical without the flag |
| 4     | Workstream 5    | docs build                                                                 |

A workerd test (`packages/do/__tests__/workerd/merge-durable-objects.workerd.test.ts`)
pins the one platform assumption: a merged instance reads its role from
`ctx.id.name` on a request and on an alarm wake after eviction.
