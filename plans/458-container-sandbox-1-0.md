# Plan 458 — Container sandbox parity with Cloudflare Sandbox SDK 1.0

**Baseline:** `f79680910` (2026-10-02)
**Status:** IN PROGRESS (workstream A shipped)

## 0. Headline finding

Cloudflare shipped [Sandbox SDK 1.0](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/)
on 2026-09-30. Despite the name, 1.0 is **not a sandbox runtime**. The 0.x
`Sandbox` class, which owned the container and ran commands, is gone. In 1.0 the
app's own Durable Object drives the container through the native
`ctx.container` API, and `@cloudflare/sandbox@1.0.0` (Apache-2.0, 112 KB, deps
`zod@4.5.4` + `aws4fetch@1.0.20`) ships just three helper classes:

- **`Files`**: streaming read/write, stat, readdir, mkdir, rename and rm against
  the running container, with Linux errno errors (`SandboxFileError`).
- **`S3Mount`**: mounts an S3-compatible bucket at a path. The Worker signs every
  request through an `S3Gateway` entrypoint, so the credentials never enter the
  container.
- **`DirectoryBackup`**: saves a directory to an R2 binding as `tar+zstd`,
  checking SHA-256 on restore, and restores it into any container, including one
  on a newer image. Storage goes through a `DirectoryBackupGateway` entrypoint
  that grants the container one object per operation.

All three exec a helper, `/usr/local/bin/sandbox-shim`, which must be present
in the image. It ships in the `cloudflare/sandbox` base image.

Everything else the changelog lists is plain `ctx.container` API, and
`@lunora/container` already wraps most of it on Cloudflare. That includes the
`durable_object` scheduling policy, per-start image and instance type,
snapshots, outbound interception and native exec. **The real gaps are the three
helper classes plus streaming / PTY exec.** The PTY half is what makes browser
terminals possible.

## 1. Current state (audit)

What 1.0 offers compared with `@lunora/container` today:

| Sandbox 1.0 capability                       | Lunora today                                                                                                                                                                                                      | Gap?    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| DO drives `ctx.container`                    | `LunoraContainer extends Container` (`packages/container/src/do/index.ts:111`)                                                                                                                                    | no      |
| Image + instance size per start              | `start({ image, instanceType })`, `durable_object` policy only (`do/index.ts:54`, `:357-368`, image resolution `:821-823`)                                                                                        | no      |
| Whole-container snapshots                    | `snapshot()` → `start({ snapshot })` (`do/index.ts:215-235`)                                                                                                                                                      | no      |
| Decide when it stops                         | `hardTimeout`, `sleepAfter`, `destroy()`, lifecycle reporting                                                                                                                                                     | no      |
| Outbound per hostname in Worker code         | allow/deny lists, `interceptHttps`, custom `OutboundHandlers` re-exported (`do/index.ts:942-955`); base installs them in `applyOutboundInterception` (`@cloudflare/containers` `dist/lib/container.js:1172-1225`) | no      |
| Run a command                                | native `ctx.container.exec`, **buffered** `{code, stdout, stderr}`, 1 MB cap, RPC-only (`do/index.ts:268-317`, `do/native-exec.ts`, `exec.ts`)                                                                    | partial |
| Streamed stdin/stdout, signals, kill, resize | runtime has it (`ContainerExecOptions.pty/stdin`, `ExecProcess.stdin/stdout/kill/resize`, workers-types `index.d.ts:3899-3923`), not exposed                                                                      | **yes** |
| Browser terminal (PTY over WebSocket)        | none                                                                                                                                                                                                              | **yes** |
| Previews from container ports                | `handle.port(n).fetch(request)` → `stub.fetch` (`client.ts:659-669`) already proxies HTTP; WebSocket upgrade through it is unverified; no hostname routing or share-token recipe                                  | docs    |
| `Files`                                      | none. The agent `fsTool` works on an **R2 bucket**, not the container disk (`packages/agent/src/sandbox.ts:430`)                                                                                                  | **yes** |
| `DirectoryBackup`                            | none. Note that the runtime also has native `snapshotDirectory()` / `directorySnapshots` (workers-types `:3934-3956`), which we don't expose either                                                               | **yes** |
| `S3Mount`                                    | none                                                                                                                                                                                                              | **yes** |

Platform matrix today: `containers`, `containerEgressPolicy` and
`containerRuntimeScheduling` are rated in
`packages/platform/src/capabilities/{cloudflare,celld,node}.ts` (cloudflare
`:106-113`, celld `:56-66`, node `:155-162`).

Pins: `@cloudflare/containers` is exact `0.3.7` and carries a local patch
(`patches/@cloudflare__containers@0.3.7.patch`); 0.3.7 is still npm `latest`.
The root `zod` pin is `4.5.4` (`pnpm-workspace.yaml:787`), the same version the
sandbox package pins, so adopting it adds no second zod copy.

## 2. Existing seams (do not reinvent)

- **`LunoraContainer` RPC methods** (`lunoraExec`, `snapshot`, `start`) are
  where each new operation goes. Exec is reachable only over RPC, never through
  `fetch`. That is the security boundary from #832, and every new op must keep
  it.
- **`awaitReadinessGate()` + `startAndWaitForPorts()` + `inflightRequests`
  accounting** (`do/index.ts:281-315`). Every new op that touches the running
  container wraps itself the same way, so `sleepAfter` cannot stop the
  container mid-op.
- **The `ContainerProxy` re-export pattern.** `@lunora/container/do`
  re-exports it, and the emitter in `packages/codegen/src/emit/shard-runtime.ts:51-60`
  surfaces it from the Worker entry. `S3Gateway` / `DirectoryBackupGateway` must
  be exported the same way, so apps never depend on `@cloudflare/sandbox`
  directly.
- **The `ContainerHandle` / `ContainerInstanceHandle` split** (`client.ts:119-180`).
  Stateful ops (files, backup, mount, terminal) belong on the **instance**
  handle (`get(name)`), not on pool `any()`. The agent sandbox already learned
  this the hard way: `sandbox-component.ts`'s `SandboxContainerAccessor.get`
  docstring explains it.
- **`readCapped` / `abortDeadline` in `shared/`** handle bounded reads and
  deadlines.
- **The agent `containerTool` / `fsTool` and `sandbox:invoke`** (`packages/agent/src/sandbox.ts`,
  `sandbox-component.ts`). A container-backed fs tool reuses this dispatch path.

## 3. The behavioural contract to preserve

- `handle.exec(...)` keeps its buffered `{code, stdout, stderr}` contract, its
  1 MB default cap and its proxied fallback for runtimes without native exec.
  Streaming is a **new** method, not a mode of `exec`.
- No new path under `/__lunora/*` becomes reachable through `fetch`.
  `refuseReserved` keeps refusing everything except the exec RPC entry.
- An app that never opts in sees no change in bundle, exports or emitted
  `_generated/containers.ts`. The golden fixtures must stay byte-identical.
- The egress policy (allow/deny, `interceptHttps`, custom handlers) keeps
  winning for every host except the gateway hosts that sandbox tools register.

## 4. Design decisions

1. **Wrap `@cloudflare/sandbox`; don't re-implement `Files`, `S3Mount` or
   `DirectoryBackup`.** We'd otherwise have to speak the `sandbox-shim` frame
   protocol ourselves, and Cloudflare owns and versions the shim and its image.
   _Rejected:_ hand-rolled file ops over `exec` (`cat`, `ls -l` parsing). They
   lose errno fidelity and break on binary data and large files.
2. **Keep `LunoraContainer` as the base. Do not adopt 1.0's "plain
   DurableObject" shape.** Ours carries RPC-only exec, Secrets Store
   resolution, readiness gates, `hardTimeout`, traces, lifecycle reporting and
   the Studio panel. The helpers only need `Pick<Container, "exec" | "interceptOutboundHttp">`,
   which `this.ctx.container` already satisfies.
   _Rejected:_ a second container base class.
3. **Opt in per container with one flag: `defineContainer({ sandbox: true })`.**
   It does three things: it makes codegen re-export the two gateways, it puts
   `files` / `backup` / `mount` on the handle's types, and it pulls
   `@cloudflare/sandbox` into the bundle. A flag is justified because the
   feature carries an image requirement (`sandbox-shim`) and its own
   Worker-entry exports, which must not leak into apps that don't use it.
   _Rejected:_ always-on, which ships zod plus two entrypoints to every
   container app. Also rejected: inferring the flag from usage, which codegen
   can't see through `ctx.containers.x.get(id)`.
4. **Streaming exec is `handle.spawn()`, which returns an `RpcTarget`.** It
   exposes `stdout` / `stderr` `ReadableStream`s, an optional `stdin`
   `WritableStream`, `exitCode: Promise<number>`, `kill(signal?)` and
   `resize(cols, rows)`. The process lives in the DO. The `RpcTarget` keeps the
   caller's control over it and holds `inflightRequests` open until it exits or
   the stub is disposed.
   _Rejected:_ a `stream: true` option on `exec`, which would change the
   return type of an existing method.
5. **The terminal is a thin helper over `spawn({ pty })`:
   `handle.terminal(request, { command, cwd, env })` returns the 101 response.**
   The DO bridges a `WebSocketPair` to the PTY: binary frames go to stdin, and a
   JSON text `{cols, rows}` frame calls `resize`. The app authenticates the
   request in its own `httpAction` before calling it.
   _Rejected:_ shipping an xterm.js client component, because nobody has asked
   for one. The client recipe goes in the docs.
6. **Previews are a docs recipe, not an API.** `handle.port(n).fetch(request)`
   already forwards HTTP. Workstream F only verifies WebSocket upgrade through
   it and documents path-prefix vs wildcard-hostname routing plus share tokens.
   _Rejected:_ a `previewRouter` helper before a second app needs one.
7. **For backups, `DirectoryBackup` comes first; native
   `snapshotDirectory()` is deferred** (see open question 2).
   `DirectoryBackup` writes to the user's own R2 bucket, verifies integrity and
   restores across images, which is what "save workspace, resume later on a new
   image" needs. The existing `snapshot()` already covers same-image resume.

## 5. Workstreams

**A. Dependency and opt-in wiring (S).**
Add `@cloudflare/sandbox: 1.0.0` (exact) to `catalog:cloudflare`, as a
dependency of `@lunora/container`. Import it only from the `/do` subpath, never
from the Node-safe root (`index.ts` header). Add `sandbox?: boolean` to
`ContainerConfigBase` (`types.ts`). When any container sets it, re-export
`S3Gateway` and `DirectoryBackupGateway` from `@lunora/container/do` and emit
them in `shard-runtime.ts` next to `ContainerProxy`. Add a golden fixture for a
`sandbox: true` app, and keep the existing fixtures byte-identical. Run
`pnpm run lint:package-json`, `api:check` and `dist:check`.

**Done.** What shipped, including where it differs from the above:

- `@cloudflare/sandbox` is a regular `dependency` of `@lunora/container`, not
  bundled. It carries no local patch, so leaving it external lets the app
  dedupe `zod`.
- The gateways are re-exported from a **new `@lunora/container/sandbox`
  subpath**, not from `/do`, so an app that never opts in never loads the
  package. The emitter adds that one export line only when some container sets
  `sandbox: true`.
- `sandbox` must be a static literal: it joined the statically-read key set
  (renamed `WRANGLER_KEYS` → `STATIC_KEYS` in `discover/containers.ts`), and a
  non-literal value is a located diagnostic. `defineContainer` rejects a
  non-boolean at runtime.
- The `containerSandboxTools` capability key and its `PlatformSignals` gate
  landed here rather than in B, because the flag is what codegen keys on.
  It is rated native on cloudflare and unsupported on celld and node, and the
  node docs table is updated.
- Container emit tests are `toContain` assertions, not golden files. The
  "unchanged output" check asserts that the `ContainerProxy` export is still
  followed directly by the first class.

**B. `files` on the instance handle (M).**
Add RPC methods on `LunoraContainer` that wrap `new Files(this.ctx.container)`:
`readFile` (returns a streaming `Response` over RPC), `writeFile` (accepts a
`string | ArrayBuffer | ReadableStream`), `stat`, `readDirectory`, `mkdir`,
`rename` and `remove`. Each goes through the readiness gate and in-flight
accounting. Expose them as `handle.files.*` on `ContainerInstanceHandle`,
typed only when `sandbox: true`. Translate errors:
`SandboxFileError.is(e)` maps to a `LunoraError` with the errno kept in
metadata (`ENOENT`→`NOT_FOUND`, `EACCES`/`EPERM`→`FORBIDDEN`,
`EEXIST`→`CONFLICT`, everything else→`BAD_REQUEST`). `SandboxProtocolError`
becomes an `INTERNAL` error whose hint reads "image lacks
/usr/local/bin/sandbox-shim — base it on cloudflare/sandbox". Add the
`createContainerTestContext` fake.

**C. `backup` on the instance handle (M).**
Add `defineContainer({ sandbox: true, backups: { bucket: "BINDING", prefix? } })`,
with `bucket` checked against `r2_buckets` through the existing binding
validation in `@lunora/config`. Wrap `DirectoryBackup` with
`ctx.exports.DirectoryBackupGateway`. Expose `handle.backup(dir, { name, exclude, gitignore })`,
which returns a `DirectoryBackupRecord`, plus `handle.restore(record, { dir? })`
and `handle.deleteBackup(record)`. **Ordering:** `DirectoryBackup.intercept()`
must register **before** the base class's `interceptAllOutboundHttp`
(`container.js:1214`), or the catch-all swallows the gateway host. So hook it
into the `LunoraContainer` start path right after `start()` and before
`applyOutboundInterception`, but only when an egress policy forces
intercept-all. Write a test for each egress mode (none, per-host, intercept-all).
Map `SandboxBackupError` codes to `NOT_FOUND`, `CONFLICT` or `INTERNAL`.

**D. Streaming exec: `handle.spawn()` (M).**
Return an `RpcTarget` (decision 4). Bound it with an optional `timeoutMs`
(kill on deadline, using the `abortDeadline` pattern) and a required
`AbortSignal` path. Keep the buffered `exec` untouched. Document that a spawned
process does **not** keep the container alive past `sleepAfter` once the
caller drops the stub, and that detached background processes are out of scope
(open question 3).

**E. Terminal: `handle.terminal(request, options)` (S, after D).**
Use `spawn({ pty: { cols, rows }, env: { TERM: "xterm-256color" } })` with the
`WebSocketPair` bridge from decision 5. Ship a docs page with the xterm.js
client snippet and reconnect backoff, mirroring Cloudflare's terminal guide.
**STOP check first:** confirm a `Response` carrying `webSocket` can be returned
from a DO **RPC** method. If it can't, see §8.

**F. Previews (S, docs + one test).**
Write a workerd test that a WebSocket upgrade survives
`handle.port(n).fetch(request)`. Then write the docs page covering path-prefix
routing (relative links only, `Host: container`), wildcard-hostname routing for
dev servers with HMR, and DO-stored expiring share tokens. Any gap the test
finds becomes its own fix inside this workstream.

**G. `mount` on the instance handle (M, lowest priority).**
Wrap `S3Mount` with `ctx.exports.S3Gateway` and expose
`handle.mount({ path, endpoint, region, bucket, keyPrefix?, access, credentials })`,
`handle.inspectMount(path)` and `handle.unmount(path)`. Take credentials only
as secret names resolved in the DO, never as literals in config. R2 needs S3 API
keys here, not an R2 binding; say so in the docs.

**H. Agent: a container-disk fs tool (S, after B).**
Add `containerFsTool(name, options)` to `@lunora/agent/sandbox` with the same
`ls/read/write/rm/stat` ops as `fsTool`, backed by `handle.files` through
`sandbox:invoke`. Reuse `MAX_FS_BYTES` and the approval gating. This gives an
agent's `exec` and its file ops the **same disk**. Today they don't share one:
exec runs in the container while `fsTool` reads and writes R2.

## 6. Platform parity

Add two new `PlatformCapabilities` keys, because the surfaces have different
host requirements:

- `containerExecStream`: `spawn` and `terminal`. Needs native `exec` with
  stdio/PTY.
- `containerSandboxTools`: `files`, `backup` and `mount`. Needs native `exec`,
  `interceptOutboundHttp`, the `sandbox-shim` image and Worker-entrypoint
  exports.

| Feature                                 | `cloudflare` | `celld`                     | `node`      | Notes                                                                                                                                                           |
| --------------------------------------- | ------------ | --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containerExecStream` (spawn, terminal) | native       | unsupported                 | unsupported | celld: native `ctx.container.exec()` is unverified (`celld.ts:66`), so this is unsupported until a TCK run proves stdio + PTY. node: no container orchestration |
| `containerSandboxTools` (files)         | native       | unsupported                 | unsupported | needs native exec, same as above                                                                                                                                |
| `containerSandboxTools` (backup, mount) | native       | unsupported                 | unsupported | celld doesn't implement outbound interception (`celld.ts:58`). The gateways ride `interceptOutboundHttp`, so there's no fallback                                |
| previews (`port(n).fetch` + WS)         | native       | (existing `containers` row) | unsupported | no new surface; covered by the existing `containers` rating                                                                                                     |

Codegen omits `spawn` / `terminal` / `files` / `backup` / `mount` from the
handle types on a target that rates them unsupported, and emits
`platform_unsupported_feature` when a `sandbox: true` container targets one.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                                                                                                                                                                          |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | A         | `pnpm run build:packages`, `api:check`, `dist:check`, `lint:package-json` green. Existing codegen goldens byte-identical, new `sandbox: true` golden added                                                    |
| 1     | B + H     | unit tests with a fake `ctx.container` (errno mapping, readiness gate, in-flight count); `pnpm run test:workerd` for `@lunora/container` (probe one suite first, since sandbox boot is environment-dependent) |
| 2     | D, then E | `spawn` unit tests (kill on deadline, `exitCode`, stdin close); WebSocket-over-RPC STOP check resolved; terminal round-trip test in workerd                                                                   |
| 3     | C         | backup → restore round-trip into an R2 fake; one interception-ordering test per egress mode                                                                                                                   |
| 4     | F, G      | WS-through-`port(n).fetch` workerd test; mount unit tests with a fake gateway. Then a **live** deploy smoke on a real account for B–G (miniflare cannot run real containers)                                  |

## 8. Risks & STOP conditions

- **STOP** if a DO RPC method cannot return a `Response` with `webSocket`
  (workstream E). Do not route the terminal through `fetch` under a reserved
  path guarded by a header: request content can forge a header, and that would
  undo #832. Re-scope instead, for example by having the app's `httpAction`
  create the `WebSocketPair` and pass one end into the RPC.
- **STOP** if `DirectoryBackup.intercept()` cannot coexist with the base
  class's intercept-all in all three egress modes. Patching
  `applyOutboundInterception` would deepen the existing
  `@cloudflare/containers` patch. Take that to the user before doing it.
- **Risk:** `@cloudflare/sandbox` imports `cloudflare:workers` and `zod/mini`
  at module top level. Mitigation: import it only from `/do`, and assert in
  `dist:check` that the root entry stays free of it.
- **Risk:** image drift, where an app on a non-`cloudflare/sandbox` image gets
  `SandboxProtocolError` at runtime. Mitigation: the hint in workstream B, plus
  an advisor lint that flags `sandbox: true` when the Dockerfile has no
  `sandbox-shim` (best-effort `FROM` / `COPY` scan).
- **Risk:** both 1.0 prerequisites (the `durable_object` scheduling policy and
  container snapshots) are public beta. `files` and `spawn` need neither.
  `backup` doesn't need the policy either. Keep them unblocked by the policy
  gate in `recordStartOverride`.
- **Perf watch:** `readFile` / `writeFile` must stream end to end. Add a
  `__bench__` case that moves a 50 MB file and asserts DO heap stays flat. The
  buffered `exec` path is the cautionary tale (`exec.ts` `maxOutputBytes`
  docstring).

## 9. Open questions (answer during execution)

1. Should `handle.files` be available **without** `sandbox: true` on images
   that happen to contain the shim? Default answer: no. One opt-in keeps the
   types honest.
2. Should native `snapshotDirectory()` / `directorySnapshots` also be exposed?
   It's Cloudflare-managed storage, has no R2 binding, and is presumably
   same-image only. Decide after C ships and someone asks.
3. Detached background processes (the `setsid` + DO-alarm + boot-id pattern
   from Cloudflare's guide). Is this a later workstream or permanently out of
   scope? Default: out of scope until a user needs a dev server that outlives
   its caller.
4. Should the 0.x code interpreter (`runCode`) get a replacement? 1.0 points to
   Dynamic Workers for JS/Python, and `@lunora/agent`'s `js-code-tool.ts`
   already uses a worker loader. Likely answer: no work needed.
5. Does celld's container adapter implement native `exec` with stdio/PTY? If a
   TCK run proves it does, raise `containerExecStream` and `files` to `native`
   on celld.
