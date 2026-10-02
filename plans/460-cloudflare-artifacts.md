# Plan 460 — Cloudflare Artifacts: an action-only `ctx.artifacts` and nothing deeper yet

**Baseline:** `f79680910` (2026-10-02)
**Status:** TODO

## 0. Headline finding

Cloudflare put [Artifacts](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)
into open beta on 2026-10-01. It is a versioned file system that speaks Git:
namespaces hold repos, and a Worker reaches them through an `artifacts`
binding. It is Workers Paid only, and billing starts 2026-10-14.

The fact that shapes this plan: **the Workers binding cannot write files.**
`env.ARTIFACTS` can create, import, fork, list and delete repos, mint and revoke
repo-scoped Git tokens, and _read_ commits, trees, blobs and files by path.
Every write is a `git push` over HTTPS with one of those tokens. The push comes
from a Git client, which can be a container, a CI runner, or isomorphic-git
inside a Worker. So the integrations that look most natural ("agent fs on a
repo", "persist the container workspace to a repo the way `DirectoryBackup`
does to R2") are really **Git-client problems**, not binding problems. A
binding wrapper alone cannot deliver either one.

Recommendation: ship a thin, action-only `ctx.artifacts` (typed wrapper, error
mapping, token-to-remote helper, test fake, platform row). Add the event types
for the existing `defineQueue` consumer path. Write one docs recipe that
connects a repo to a plan-458 container through `exec` plus a short-lived
token. Do **not** build an Artifacts-backed agent `fsTool` or a
`backups: { artifacts }` mode on containers until someone asks for one.

## 1. Current state (audit)

Lunora has **config-level** support only. Nothing reads the binding at runtime.

| Area                            | What exists                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wrangler config typing          | `artifacts?: { binding, namespace, remote? }[]` (`packages/config/src/cloudflare/wrangler-config.ts:77-79`)                                                                                                                                                        |
| binding validation              | required `binding` + `namespace` rule (`packages/config/src/cloudflare/validate-bindings.ts:764-771`)                                                                                                                                                              |
| env inheritance                 | `artifacts` listed as non-inheritable (`packages/config/src/cloudflare/wrangler-environment.ts:25-29`)                                                                                                                                                             |
| binding manifest                | `{ field: "artifacts", resourceKey: "namespace", type: "artifacts" }` (`packages/config/src/cloudflare/binding-manifest.ts:194`). All four came from #914 (`e5297a975`)                                                                                            |
| binding inference               | **none.** There's no `usesArtifacts` in `CAPABILITY_SOURCES` (`packages/config/src/infer-bindings.ts:93-110`)                                                                                                                                                      |
| `ctx.*` surface                 | **none.** There's no row in `CAPABILITY_ROWS` (`packages/codegen/src/capabilities.ts:87`), none in `CAPABILITY_TO_FEATURE` (`packages/codegen/src/platform-target.ts:203`), and no `@lunora/bindings/artifacts` subpath (`packages/bindings/package.json` exports) |
| `PlatformCapabilities`          | **no `artifacts` key** in `packages/platform/src/capabilities/{types,cloudflare,celld,node}.ts`                                                                                                                                                                    |
| agent fs                        | `fsTool(bucket)` is R2-only, with ops `ls/read/write/rm/stat` (`packages/agent/src/sandbox.ts:130-135`, `:430`), executed by `runFsOp` over `R2BucketLike` (`packages/agent/src/sandbox-component.ts:422`)                                                         |
| container workspace persistence | plan 458 workstream C (`DirectoryBackup` → R2) is **not started**. 458 A (the `sandbox: true` opt-in + `@lunora/container/sandbox` subpath) has shipped                                                                                                            |
| jurisdiction                    | `JurisdictionIR = "eu" \| "fedramp" \| "us"` (`packages/codegen/src/ir.ts:285`) pins DOs (`packages/container/src/jurisdiction.ts`). Artifacts supports only `eu` / `us`, set **per namespace at creation, immutable**                                             |

**Upstream facts verified today** (docs fetched 2026-10-02, plus the pinned toolchain):

- Binding API (the docs' "Workers binding" page). Namespace methods:
  `create(name, {readOnly, description, setDefaultBranch})`, `get(name)`,
  `list({limit, cursor})`, `import({source:{url,branch,depth}, target:{name, opts}})`,
  `delete(name)`. Repo handle methods (`Disposable`, meant to be used with
  `using`): `info()`, `createToken(scope="write", ttl)`, `listTokens()`,
  `revokeToken(tokenOrId)`, `fork(name, {defaultBranchOnly, …})`,
  `log({ref, limit≤1000, offset})`, `readCommit(sha)`, `readTree(sha)`,
  `readBlob(sha) → Blob|null`, `readFile({ref, path}) → Blob|null` (MIME-typed).
  **None of these write.**
- **Our pinned `@cloudflare/workers-types@5.20260929.1` lags the docs.**
  `index.d.ts:12434-12669` declares only the token, fork and namespace methods.
  `info`, `log`, `readCommit`, `readTree`, `readBlob` and `readFile` are absent.
  `ArtifactsRepo` _extends_ `ArtifactsRepoInfo` (metadata as properties), while
  the docs say "metadata is not exposed as properties, call `info()`". The
  Blob-returning methods need wrangler ≥ 4.145.0, and the catalog pins
  `wrangler: ^4.143.1` (`pnpm-workspace.yaml:380`).
- **No local simulator.** miniflare's `ARTIFACTS_PLUGIN` only binds a
  remote-proxy service (`miniflare@5.20260926.1-alpha` `dist/src/index.js:111833-111870`).
  So `lunora dev` and every test that touches the real binding need an
  authenticated account. Unit tests have to use a fake.
- Errors: `ArtifactsError { code, numericCode }` with 12 codes
  (`ALREADY_EXISTS`, `NOT_FOUND`, `IMPORT_IN_PROGRESS`, `FORK_IN_PROGRESS`,
  `INVALID_INPUT`, `INVALID_REPO_NAME`, `INVALID_TTL`, `INVALID_URL`,
  `REMOTE_AUTH_REQUIRED`, `UPSTREAM_UNAVAILABLE`, `MEMORY_LIMIT`,
  `INTERNAL_ERROR`).
- Events go through **Queues event subscriptions**. The account-level source
  `artifacts` carries `cf.artifacts.repo.{created,deleted,forked,imported}`. The
  repo-level source `artifacts.repo` carries `pushed`, `cloned`, `fetched` and
  `token.{created,revoked}`. miniflare already lists the nine type strings
  (`index.js:86040-86049`).
- Limits: 1 GB per repo, 32 MB per blob, and 2,000 control-plane requests per
  10 s per namespace. Token TTL is 60 s to 1 y (default 86,400 s). The
  `wrangler artifacts` CLI has `namespaces list|get` and
  `repos create|list|get|delete|issue-token`. **It has no `namespaces create`.**
  A namespace is either auto-created by the first repo `create` (unrestricted)
  or created over REST with `{ jurisdiction: "eu" | "us" }`.

## 2. Existing seams (do not reinvent)

- **`@lunora/bindings/<x>` subpath + `CAPABILITY_ROWS` row + `emit*Fragments`.**
  `ctx.images` is the template to copy line for line: the row is at
  `capabilities.ts:161-168` (action-only `contextField`, `appMethod` override),
  the emitter is `emitImagesFragments` (`packages/codegen/src/emit/shard-bindings.ts:445`),
  and the client is `createImages` (`packages/bindings/src/images/create-images.ts`).
  Its action-only rationale (non-deterministic network I/O) applies verbatim.
- **`CAPABILITY_SOURCES` in `infer-bindings.ts`.** One entry gives import
  detection, the `Capabilities` type, merging and the hint text. The
  "hint (un-mintable)" vs "self-describing" split is documented at `:86-92`.
- **`binding-manifest.ts` / `validate-bindings.ts` already handle `artifacts`.**
  Don't add a second validation path. Extend these. Uncommitted work in this
  checkout (2026-10-02) threads the schema's jurisdiction into
  `HINT_BINDING_RULES` hint messages (`HintBindingRule.hintMessage(label, binding, jurisdiction)`,
  KV first). If that lands, decision 5's jurisdiction-aware hint is just one
  more row in that table, not a new mechanism.
- **Queue event typing precedent.** `BrowserRunCrawlEvent` / `BrowserRunEventEnvelope`
  (`packages/browser/src/types.ts:180-215`) types a Cloudflare event
  subscription payload for consumption through `defineQueue` (`@lunora/queue`).
  Artifacts events follow it exactly.
- **`@lunora/errors` `LunoraError`** is the target for error mapping, as in
  plan 458 B's `SandboxFileError` mapping.
- **Plan 458's `ContainerInstanceHandle` + `exec`** is the only Git client
  Lunora has today. The container recipe (workstream C) uses the existing
  `exec(..., { env })` path. It adds no new container API.
- **`PlatformSignals` / `gateAgainstMatrix`** (`packages/codegen/src/platform-target.ts`):
  the `platform_unsupported_feature` diagnostic comes for free once
  `CAPABILITY_TO_FEATURE` maps the row.

## 3. The behavioural contract to preserve

- An app that never imports `@lunora/bindings/artifacts` gets byte-identical
  generated output (`_generated/server.ts`, the shard ctx, wrangler inference).
  Every existing codegen golden stays unchanged.
- The existing `artifacts` wrangler validation and manifest rows keep their
  messages and shapes (tests in `packages/config/__tests__` keep passing
  untouched).
- `ctx.artifacts` never appears on `QueryCtx` / `MutationCtx`. Mutations stay
  deterministic and side-effect-free outside the DO transaction.
- No token plaintext is ever logged, traced or returned in an error message.
  This mirrors how the 458 sandbox gateways treat credentials.

## 4. Design decisions

1. **Ship a binding wrapper, action-only.** `ctx.artifacts` lives on `ActionCtx`
   only, which is the `ctx.images` precedent: every call is remote network I/O
   to a billed service. It adds four things the raw binding lacks:
   (a) **our own structural types**, because the pinned workers-types lack the
   read methods and model metadata wrongly (§1), and depending on them would
   ship a surface that does not type-check;
   (b) `ArtifactsError` mapped to `LunoraError` (`NOT_FOUND`→`NOT_FOUND`,
   `ALREADY_EXISTS`/`*_IN_PROGRESS`→`CONFLICT`, `INVALID_*`→`BAD_REQUEST`,
   `REMOTE_AUTH_REQUIRED`→`FORBIDDEN`, `UPSTREAM_UNAVAILABLE`/`MEMORY_LIMIT`/`INTERNAL_ERROR`→`INTERNAL`,
   with `code`/`numericCode` kept in metadata);
   (c) `withRepo(name, fn)`, which owns the `using` disposal so a handle can't
   leak past the request;
   (d) `authenticatedRemote(remote, token)`, which strips `?expires=…` and
   builds the `https://x:<secret>@host/…` URL every Git-client recipe needs.
   Everything else passes straight through.
   _Rejected:_ exposing raw `env.ARTIFACTS`. Apps already have that, and it
   gives them neither the types nor the error mapping. _Rejected:_ a
   higher-level "versioned document store" abstraction, which has one
   imagined consumer.
2. **No write API in Lunora.** The service has none. Synthesising one
   (isomorphic-git pack building inside a Worker) puts a Git implementation in
   every app bundle, runs into the 32 MB blob / 128 MB isolate limits, and
   duplicates what a container's `git` already does.
   _Rejected until requested:_ `ctx.artifacts.writeFile` via isomorphic-git.
3. **The agent `fsTool` stays R2-backed.** Without writes, an Artifacts-backed
   `fsTool` would be read-only, which breaks the `write`/`rm` ops of
   `FsToolInput` (`sandbox.ts:130-135`). Plan 458 H (`containerFsTool`) is
   already the answer for "agent exec and fs share one disk". Persisting that
   disk to Artifacts is the workstream C recipe (the agent's container runs
   `git push`), not a new tool.
   _Rejected:_ `artifactsFsTool` with `write` implemented by pushing from the
   Worker (same reason as decision 2). Also rejected: a read-only variant
   nobody has asked for.
4. **Container persistence is a docs recipe, not a `backups` mode.** Plan 458
   C's `DirectoryBackup` is a tar+zstd snapshot to the app's own R2 bucket,
   with credentials kept out of the container by a gateway. Artifacts
   persistence is `git push` _from inside_ the container with a short-lived
   token in its env. The trust model, the storage format and the restore
   semantics all differ (history and diffs vs an opaque archive). Folding
   both into `defineContainer({ backups })` would mean one config key with two
   credential models.
   _Rejected:_ `backups: { artifacts: "BINDING" }`. Revisit only if a user
   needs Lunora-managed push-on-sleep, and even then put it beside 458 C, not
   inside it.
5. **Binding inference is a hint and never auto-writes.** A namespace's
   jurisdiction is fixed at creation, and the first `create()` against a
   missing namespace auto-creates it _unrestricted_. Auto-writing
   `{ binding: "ARTIFACTS", namespace }` into a `.jurisdiction("eu")` app would
   let the first repo create a permanently non-EU namespace. So the inference
   entry is hint-class, like KV and hyperdrive. When the schema has a
   jurisdiction, the hint prints the REST `POST …/artifacts/namespaces`
   call with `"jurisdiction"`.
   _Rejected:_ self-describing auto-write, which is fine for `images` but not
   for a resource with an immutable residency property.
6. **`fedramp` schemas get a codegen error when they use Artifacts.** Artifacts
   offers only `eu`/`us`, so pairing a fedramp-pinned app with it is a
   residency violation that codegen can see statically.
   _Rejected:_ a warning, because residency is not best-effort.
7. **Events reuse `defineQueue`.** We only add the `ArtifactsEvent`
   discriminated union. The subscription itself is
   `wrangler queues subscription create --source artifacts[.repo] …`, which is
   documented and not automated (the Browser Run precedent).
   _Rejected:_ a `defineArtifactsTrigger` builder. It would be a second
   queue-consumer mechanism.
8. **No Workers Builds integration.** A push-to-deploy Build bypasses
   `lunora deploy`'s codegen, migrations and schema-drift gate. The docs page
   says so in one paragraph.
   _Rejected:_ wiring Lunora into Workers Builds from an Artifacts repo. That
   would be a deploy-pipeline project, not a binding.

## 5. Workstreams

**A. `@lunora/bindings/artifacts` + `ctx.artifacts` (M).**
Add a new subpath `packages/bindings/src/artifacts/{index,types,create-artifacts,remote}.ts`
plus the `package.json` export. `types.ts` declares a structural
`ArtifactsBindingLike` / `ArtifactsRepoLike` matching the **docs** surface
(including `info()` and the Blob readers), so the subpath compiles against the
lagging workers-types. `createArtifacts(binding)` returns `Artifacts` with
`create`, `import`, `list`, `delete`, `get → info`, `withRepo`, and the repo
ops `createToken`, `revokeToken`, `listTokens`, `fork`, `log`, `readCommit`,
`readTree`, `readFile` and `readBlob`, plus `authenticatedRemote`. It also
applies the decision-1 error mapping.
Codegen: add a `CAPABILITY_ROWS` row (`key: "artifacts"`, action-only
`contextField`, `appMethod` `artifacts` defaulting to `env.ARTIFACTS`), an
`emitArtifactsFragments` in `shard-bindings.ts`, a `CAPABILITY_TO_FEATURE`
entry `artifacts: "artifacts"`, and a golden fixture for an importing app.
Config: add `usesArtifacts` to `CAPABILITY_SOURCES` as a hint (decision 5).
Codegen diagnostic: `.jurisdiction("fedramp")` + artifacts usage is an error
(decision 6).
Testing: export a `createArtifactsFake()` from `@lunora/testing` (in-memory
repos, tokens and files keyed by `ref:path`), because miniflare has no
simulator. Gates: `api:check`, `dist:check`, `lint:package-json`.

**B. Event types (S, independent of A's codegen half).**
Add `ArtifactsEvent = ArtifactsRepoLifecycleEvent | ArtifactsRepoActivityEvent`
in `@lunora/bindings/artifacts/types.ts`, shaped from the nine documented
payloads, with `eventSchemaVersion: 1` in the envelope. Write a docs section
that shows a `defineQueue` consumer narrowing on `type` and the two
`wrangler queues subscription create` commands. Add one type-level test per
event.

**C. Container ↔ repo recipe (S, docs + one live smoke, after plan 458 B).**
This is a docs page under `packages/container/docs/`. An action mints a
`createToken("write", ≤ 3600)`, builds `authenticatedRemote`, and runs
`git clone` / `git push` through `handle.exec(cmd, { env: { ARTIFACTS_GIT_REMOTE } })`
on a `sandbox: true` container. It then revokes the token with `revokeToken`
when the session ends. The page states the contrast with 458 C
(credential-in-container vs gateway) and when to pick each. It also points
large repos at ArtifactFS (FUSE) as an image-level choice that Lunora does
not wrap. One live deploy smoke runs clone → commit → push → `readFile`
round-trip. No container API change.

**D. Deploy-time namespace jurisdiction check (S, optional, gated on open question 1).**
If `wrangler artifacts namespaces get --json` reports the jurisdiction,
`lunora doctor` / the deploy preflight compares it with the schema's
`.jurisdiction()` and fails on a mismatch, or when the namespace is missing
for a pinned app. If the API doesn't expose it, drop D and leave the decision-5
hint as the only control.

**Explicitly out of scope** (each one waits for a real request): an
Artifacts-backed agent fs tool, a `backups: { artifacts }` container mode, a
Worker-side Git writer, Workers Builds wiring, and automatic namespace
creation or event-subscription provisioning in `lunora deploy`.

### Interaction with plan 458

| 458 workstream             | Effect of this plan                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (opt-in, **done**)       | none. Recipe C requires `sandbox: true` only because it uses 458 B `files` to stage the workspace; plain `exec` works without it                                                                                    |
| B (`files`)                | none to its API. Recipe C uses it if available                                                                                                                                                                      |
| C (`DirectoryBackup` → R2) | **stays the one built-in persistence mode.** Artifacts is documented next to it as a user-driven alternative (decision 4); 458 C's `backups` config gains no `artifacts` variant. 458 open question 2 is unaffected |
| D/E (`spawn`, terminal)    | none. A terminal session can `git push` by hand with the recipe's remote                                                                                                                                            |
| G (`S3Mount`)              | none. Artifacts is not S3-compatible; ArtifactFS is its mount story                                                                                                                                                 |
| H (`containerFsTool`)      | **this is the agent answer** (decision 3). An agent that wants versioned output runs `git push` via its `containerTool`. No Artifacts tool is added                                                                 |

## 6. Platform parity

This adds one new gate-bearing `PlatformCapabilities` key, `artifacts`. It is
mapped from the `artifacts` capability row, so codegen omits `ctx.artifacts`
and emits `platform_unsupported_feature` on any target that rates it
unsupported.

| Feature                                | `cloudflare` | `celld`                     | `node`      | Notes                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------ | --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts` (`ctx.artifacts`)          | native       | unsupported                 | unsupported | Cloudflare: Artifacts binding, open beta, Workers Paid only, and remote-only even in `lunora dev`. celld has no Artifacts binding type. node has no equivalent; a host would need a Git server with repo-scoped tokens, which no host contract (`ShardHost` … `SchedulerHost`) carries |
| Artifacts events (`ArtifactsEvent`)    | native       | unsupported                 | unsupported | types only. Delivery rides the existing `queues` row; the subscription source exists only on Cloudflare                                                                                                                                                                                |
| namespace jurisdiction (`eu` / `us`)   | native       | unsupported                 | unsupported | covered by the `artifacts` row. `fedramp` is unsupported on every target (decision 6)                                                                                                                                                                                                  |
| container ↔ repo recipe (workstream C) | native       | (existing `containers` row) | unsupported | no new surface. It is `exec` + `fetch`-reachable Git, already rated                                                                                                                                                                                                                    |

`packages/platform-node/docs/index.mdx`'s capability table gets the new row in
the same change (`lint:node-capabilities-docs`), and the `types.ts` header's
gate-bearing key list gains `artifacts`.

## 7. Phasing & ordering

| Phase | Work                                                 | Gate                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | A (bindings subpath, types, fake, error mapping) + B | `pnpm --filter "@lunora/bindings..." run build`, unit tests against `createArtifactsFake` (error mapping per code, `withRepo` disposes on throw, `authenticatedRemote` strips `?expires=`), `api:check`, `dist:check`, `lint:package-json` |
| 1     | A (codegen + platform row + inference)               | new golden for an `@lunora/bindings/artifacts`-importing app; existing goldens byte-identical; `target: "node"` app gets `platform_unsupported_feature`; fedramp schema + import → codegen error; `lint:node-capabilities-docs` green      |
| 2     | C (after 458 B), D if open question 1 resolves       | live deploy smoke on a Workers Paid account: create → token → container clone/commit/push → `readFile` returns the pushed content → `revokeToken` → push now fails                                                                         |

## 8. Risks & STOP conditions

- **STOP** if the live binding's surface differs from the docs' surface (for
  example, `get()` returning metadata properties as the pinned types claim,
  or the Blob readers missing on the deployed runtime). Fix `types.ts` to
  match the runtime, not the docs, and re-check decision 1(a) before
  shipping.
- **STOP** if open beta changes the binding so that it gains write methods.
  Decisions 2–4 rest on "no writes" and must be re-litigated, not patched
  around.
- **Risk:** workers-types catches up and conflicts with our structural types.
  Mitigation: keep `ArtifactsBindingLike` structural (not `declare global`),
  and once the pin includes the read methods, add a type test asserting the
  global `Artifacts` is assignable to it. Bumping wrangler to ≥ 4.145.0 in the
  catalog is a separate `deps` change.
- **Risk:** the recipe leaks a write token into container env or process
  listings. Mitigation: TTL ≤ 1 h in the recipe, `revokeToken` on session end,
  never echo the remote in logs, and the docs state the trust difference
  from 458's gateway model.
- **Risk:** cost surprise. Every `ctx.artifacts` call is a billed operation
  (10k/month included). Mitigation: a docs note, plus an advisor lint
  candidate (not in scope) for `ctx.artifacts.*` inside loops.
- **Perf watch:** `readFile` returns a `Blob`. The wrapper must hand it back
  unbuffered (no `.text()` / `arrayBuffer()` inside Lunora). Add a unit
  assertion against the fake that the returned object is the binding's Blob
  instance.

## 9. Open questions (answer during execution)

1. Does `wrangler artifacts namespaces get --json` (or REST `GET …/namespaces/:name`)
   return the namespace's `jurisdiction`? This decides workstream D.
2. Does the deployed runtime match the docs (handle methods `info()` /
   `readFile()`, `Disposable`), or the pinned workers-types (metadata
   properties)? The docs' own sandbox example reads `repo.defaultBranch`
   directly, so the two disagree. Settle this in the phase-0 live probe.
3. Does the `cloudflare/sandbox` base image ship `git`? If not, recipe C has to
   state the `RUN apt-get install git` line, and plan 458's advisor
   `sandbox-shim` check stays the only image lint.
4. Should `ctx.artifacts` take a per-call namespace (multiple `artifacts[]`
   bindings)? Default: no. One binding per `ctx` property, with
   `appMethod` override, like `ctx.images`.
5. Is the remote-only dev story acceptable, or does `lunora dev` need a
   warning when an app imports `@lunora/bindings/artifacts` while wrangler is
   unauthenticated? Default: reuse whatever `browser` / `ai` do today, and add
   nothing new.
