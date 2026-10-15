# The build box (GAPS.md A3)

The container image that turns a repo tarball into a release: the single Worker
module the deploy path uploads, plus the binding manifest, crons and static
assets it deploys with. One throwaway instance per build.

This is the 🌐 half of A3. Everything around it — the `builds` table, the work
lease, `builds.claimNext`, the dispatcher, log streaming, commit-SHA dedup and
the release into the deploy core — is code in `src/builds/`; see **Wiring**.

## The contract

| Route                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__lunora/build` | Body **is** the gzipped repo tarball; optional `?rootDirectory=apps/web` for a monorepo project and `?runtime=worker` for a plain Cloudflare Worker project (absent or `lunora` builds a Lunora app; anything else is a `400`). Responds NDJSON: `{"line"}` per output line as it happens; one `{"advisory":{"name","level":"WARN","title","detail","file","line","location","cacheKey","remediation"}}` per bundle-scan finding (each also logged as a `warning: …` line), before the release; then the release `{"bundle","bundleHash","manifest","assets"?,"cronSpecs"?,"scriptName"?,"workspacePackages"?}` (`workspacePackages`: the repo-relative workspace packages the app imports, for the path filter) or `{"error"}`. Advisories never ride on the release. |
| `POST /__lunora/exec`  | The `@lunora/container` exec contract, verbatim — `{command,args,cwd,env,timeoutMs}` → `{code,stdout,stderr}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /__lunora/health` | Readiness probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Why a build route and not just exec.** `BuildRunnerPorts.execute` receives the
source as an `ArrayBuffer` in the Worker, and exec has nowhere to put it — it
sends `{command,args,cwd,env}` and nothing else, so a 40MB tarball cannot travel
through it. Exec also buffers its whole response to parse it, capped at 1MB by
default; a real build log is bigger. Streaming NDJSON solves both and is what
lets the dashboard tail a build live, which is what `buildLogs` is for.

## What it does, and the two decisions inside it

1. Extract the tarball from the request body (`--strip-components=1` drops
   GitHub's `<owner>-<repo>-<sha>/` wrapper).
2. **Resolve the root directory** (`workspace.mjs`). The `rootDirectory` query
   parameter is re-validated (normalized, relative, no `..`; a bad one is a
   `400` before the body is read), then `realpath`-resolved inside the
   extracted repo and prefix-checked against the repo's own real path, so a
   symlinked directory cannot point the build outside it. A missing directory
   is refused with a log line naming it. The **workspace root** is the nearest
   directory from there upward that holds a lockfile, never above the repo —
   for a pnpm/npm/yarn workspace that is the repo root.
3. **Install with the manager the lockfile names**, at the workspace root — `pnpm-lock.yaml` → pnpm,
   `package-lock.json` → npm, `yarn.lock` → yarn. Never a default: installing a
   pnpm project with npm resolves a different graph than the one the tenant
   tested, and it surfaces as a mystifying build error rather than as "wrong
   manager". No lockfile is refused.
4. **Run `node_modules/.bin/lunora build` directly**, in the root directory —
   the nearest `node_modules/.bin/lunora` from there up to the workspace root — not `pnpm exec`, not
   `npm exec`, not `yarn run`. Every manager's exec treats a missing binary as
   "fetch it from the registry": verified against npm 10, where both
   `npm exec --no --` and `npx --no` still resolve from the network. A project
   that never declared the CLI would therefore be built by whatever version is
   latest that day — an unpinned toolchain swap, silent, with `404 lunora` as
   the only clue. The `.bin` path can only be the version the lockfile
   installed, and its absence is a clear error. (Yarn PnP writes no `.bin` and
   is refused rather than guessed at.)
5. Collect the built module (from the root directory's `.lunora/build`) and hash it. The deploy path uploads exactly **one**
   `main_module` (`src/cloudflare/api.ts` sets a single form part), so a build
   that produced several modules is refused here rather than deployed as
   whichever file sorted first — that would ship a Worker missing half its code,
   first noticed as a runtime import error in production.

6. **Collect the release** (`release.mjs`). The same pinned `.bin/lunora` runs
   `lunora cloud deploy --bundle <module> --out <file>`, which writes exactly the
   request body a CLI deploy would upload — binding manifest, crons and static
   assets derived from the project's wrangler config — without authenticating.
   The file is read back, held to the control plane's caps (100 MiB body, 50 MiB
   and 20,000 files of assets) so an oversized project fails here with the cap
   named, and its routing fields are dropped: the control plane decides project,
   kind and branch from the build row. A CLI too old for `--out` (anything
   before the next `@lunora/cli` release) fails the build with an error saying
   so and naming the upgrade — a build that can never be released never reads
   green.

7. **Scan the bundle** (`scan.mjs`), over the exact bytes hashed in step 5 and
   with the release's manifest in hand — see _The bundle scan_ below. It only
   warns, and a scan that cannot run is a single
   `warning: build scan skipped: <reason>`; the build carries on.

### The Cloudflare Worker runtime (`?runtime=worker`)

A project whose `runtime` setting is `worker` is a plain Cloudflare Worker: a
`wrangler.json`, `wrangler.jsonc` or `wrangler.toml` and its own pinned
`wrangler`, no Lunora CLI. Steps 1–3 and 7 are the same; 4–6 become
(`worker.mjs`):

4. **Find the config** in the root directory itself — never searched for
   upward, as wrangler would — and **resolve `node_modules/.bin/wrangler`**
   the way `.bin/lunora` is resolved: the lockfile's version or a clear
   error, never a registry fetch. A project depending on
   `@cloudflare/vite-plugin` is refused: its deployable output comes from
   `vite build`, which this path does not run (custom build steps belong in
   wrangler's own `build.command`, which `wrangler deploy` runs).
5. **Read the resolved config with the tenant's wrangler**
   (`unstable_readConfig` / `experimental_readRawConfig`), in a child process
   started with `node --input-type=module --eval` so the program is never a
   file a build could replace. TOML and JSON alike; `main` absolute; only the
   keys the file declares; the top-level environment (a git build has no
   `--env`). The JSON it writes is translated **here**, with the vendored
   `buildBindingManifest` and `collectAssets` — the exact code
   `lunora cloud deploy --out` runs — into the same release body, plus
   `manifest.vars`. Refused, by name: a non-string var (Cloudflare would bind
   it as JSON; Lunora Cloud deploys vars as plain text), an assets binding not
   named `ASSETS` (the provision box always binds assets as `ASSETS`; a config
   that names no binding gets `ASSETS` added), no `main`, `no_bundle`, any
   Durable Object migration step but `new_sqlite_classes` (a rename or
   transfer would end with the old data deleted; `new_classes` is KV-backed,
   and Lunora Cloud runs SQLite-backed classes), and any queue-consumer
   setting or `http_pull` consumer (nothing the platform attaches applies them).
   The static files themselves are collected after step 6 — the dry run runs
   the config's `build.command`, whose output they may be — and an assets
   directory that is missing then, or that leads (or holds a symlink that
   leads) outside the repository, is refused.
6. **Bundle behind the entry shim.** `wrangler deploy <shim> --config <config>
--dry-run --outdir <dir>`, with `WRANGLER_SEND_METRICS=false`,
   `WRANGLER_HIDE_BANNER=true` (the banner is what runs the update check),
   wrangler's log beside the repo and every `CLOUDFLARE_*` variable removed.
   The out-dir, the logs and the resolved config live in `<workspace>.worker/`,
   beside the extracted repo. The shim is written to the project's
   `.wrangler/lunora-cloud/` instead — created fresh, refused when `.wrangler`
   is a symlink — because esbuild names every input relative to the project
   in the bundle, so an entry under the build's random workspace name would
   give the same commit a different bundle hash on every build; `.wrangler` is
   also a directory the scan already treats as generated. Two builds of one
   commit produce the same bundle. Then the single module is collected (`rules` /
   `find_additional_modules` / split chunks produce several and are refused)
   and the release written to the same file step 6 of a Lunora build reads.

**The entry shim** (`shim-runtime.mjs`, bundled into the Worker). A Worker in a
Workers for Platforms dispatch namespace (`cloudflare-wfp`) gets no
`triggers.crons` and cannot be a queue consumer, so the control plane delivers
both over HTTP — `POST /_lunora/scheduled` and `POST /_lunora/queue`, the
contract `@lunora/runtime`'s `tenant-fanout-routes.ts` serves. A plain Worker
serves neither: without the shim its crons would never fire and the platform
consumer would acknowledge — and lose — its queue messages. The generated entry
is

```js
import * as worker from "<main>";
import { wrapEntry } from "./shim-runtime.mjs";

export * from "<main>";
export default wrapEntry(worker.default, { "--job-queue": "jobs" });
```

so every class the Worker exports (Durable Objects, Workflows, named
entrypoints) is still an export of the bundle, and `wrapEntry`:

- answers the two routes only with the deployment's admin bearer
  (`env.LUNORA_ADMIN_TOKEN`, set on every deployment), compared in constant
  time and checked before the method or the body — `403 ADMIN_FORBIDDEN`
  otherwise, the runtime's envelope and body caps throughout;
- runs `scheduled(controller, env, ctx)` for a tick, and `queue(batch, env,
ctx)` for a batch, with a `MessageBatch`-shaped object whose `ack()` /
  `retry()` / `ackAll()` / `retryAll()` follow Cloudflare's semantics — an
  explicit per-message call wins, a returning handler acknowledges the rest, a
  throwing one retries everything not acknowledged explicitly — answered as
  `{"retry":[ids]}`;
- maps the project's queue name (`{alias}--{producer binding}`) back to the
  Worker's own (`jobs`) — on a forwarded batch and on a native one alike (a
  native batch is the real one behind a proxy, so its `ack()` / `retry()` reach
  Cloudflare) — so `batch.queue` reads
  what the Worker's config says;
- passes every other request to the Worker's `fetch()` — on the Worker's own
  object, so `this` and prototype methods (a framework app instance) behave as
  before — and keeps its other handlers. A `WorkerEntrypoint` class default
  becomes a subclass that, once the Worker's constructor has run, replaces each
  instance's `fetch` / `queue` with routing wrappers — so a handler declared as
  a class field, which would shadow a subclass method, is routed too. A service-worker script (no default
  export) fails at upload with a message saying so.

The shim is applied on every target: the box does not know the target, and a
build is reused across a target change. Where crons and consumers are native
(`cloudflare-workers`, `celld-vps`) the platform never calls the two routes, and
the wrapper hands Cloudflare's own `scheduled` / `queue` events to the Worker —
a queue batch under the Worker's own queue name, as above.

**The vendored translation.** `vendor/release-manifest.mjs` is an esbuild bundle
of `buildBindingManifest` (`packages/config`) and `collectAssets`
(`packages/cli`), with the third-party code `collectAssets` pulls in
(`@visulima/fs`, `@visulima/path`) and their licences in
`vendor/release-manifest.LICENSES`. `apps/cloud/scripts/vendor-release-manifest.ts`
writes both; `__tests__/build-box-worker-vendor.test.ts` re-bundles in memory
and fails while the committed copy differs, so a change to either source is:
run the script, commit both files.

### The bundle scan

Code that, once started, can run without end and bill storage operations on
every pass. Each finding is one `{"advisory"}` record plus a log line —
`warning: …` for `WARN`, `note: …` for `INFO`, so the Studio's Warnings tab
(which matches "warn") picks up only the former.

| Advisory              | Level                                                                                                                      | Reported when                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not covered                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unbounded_loop`      | `WARN`                                                                                                                     | `while`/`do … while` on `true`, a non-zero number (`while (1)`) or `!0`, or `for (;;)`/`for (; true;)`, with no statically reachable exit: no `break` bound to it, no jump to a label outside it, no `return`/`throw`/`yield` in its own function, no `signal.throwIfAborted()`. An `await` is not an exit.                                                                                                                                           | A condition that is not a literal (`while (running)`), however it is set.                                                                                                                                                                  |
| `alarm_always_rearms` | `WARN` when the re-arm is `Date.now()`, under a minute ahead, or a delay the scan cannot read; `INFO` at a minute or more. | A class's `alarm() {}` or `alarm = () => {}` field calls `<x>.storage.setAlarm(…)` (or a destructured `storage.setAlarm(…)`) at a position that runs on every call — not in a branch, loop body, `case`, `catch`, ternary arm, the far side of `&&`/`\|\|`/`??`, an optional chain, a nested callback, or after an earlier statement that may leave — not kept, not followed by a `throw`, and not followed by a `deleteAlarm()` on the same storage. | Delays read only as `Date.now() + <constant>` (optionally in `new Date(…)`); a storage held under any other name; minified code where the bundler renames `storage`, `setAlarm` or `deleteAlarm` (esbuild does not rename properties).     |
| `queue_self_resend`   | `WARN`                                                                                                                     | A hand-written `queue(batch, env)` handler (object method, arrow or class method via `this.env`; `env` named or destructured) `send`s/`sendBatch`es, unconditionally or once per message in `for (const m of batch.messages)`, to a producer the release manifest maps to a queue this Worker consumes.                                                                                                                                               | Lunora `defineQueue` consumers (dispatched through generated and runtime code, not a hand-written `queue()`); sends inside `batch.messages.forEach(…)` or a helper function; minified code that renames `messages`, `send` or `sendBatch`. |

**Noise control.** Every candidate is attributed through the bundle's sourcemap
(wrangler writes `index.js.map` beside the module in `--outdir` mode) and
dropped when its source is under `node_modules`, in generated output
(`.wrangler`, `.lunora`) or outside the repository — the repository rather than
the root directory, so a monorepo's own workspace packages are still scanned.
Without a usable sourcemap, esbuild's `// <path>` region comments name each
statement's input (the line reported is then the bundle's); without either, a
finding is kept against the bundle itself.

**Limits.** At most 50 findings per build, of which at most 10 placed only by
bundle line; whichever cap applies is named in a `warning: build scan: …` line.
A reported path is capped at 512 characters, and its `cacheKey` carries a digest
of the full path, so two long paths never collapse into one finding. The scan
skips itself, with the reason, on an unparsable bundle, one over 32 MiB, or past
its 10-second budget — checked during the parse (per token) and every walk,
including the ancestor walks jump resolution makes. Memory is guarded, never
discovered: the scan estimates its heap up front (48 bytes per bundle byte,
against a 256 MiB reserve that covers V8's young generation, which
`heap_size_limit` includes) and also watches the free heap during the parse and
walks, stopping at the reserve — dense code costs more than any estimate
(`var a = 1;` lines measured ~80 bytes per byte), and running this process out of
heap would end the stream with no release, failing the build. A sourcemap that
is not a regular file, over 64 MiB, more than the remaining heap holds (budgeted
at 4× its size; measured ~1.3×), not JSON, or named by a malformed
`sourceMappingURL` is not used: the scan goes on with bundle-line attribution
and says so.

### The parser, and why it is vendored

The scan needs a JavaScript parser, and this image installs nothing. So
`vendor/acorn.mjs` is the catalog-pinned `acorn` release's own prebuilt ESM
file (zero dependencies, MIT; the licence is beside it), copied verbatim and
`COPY`'d like the rest — no build step and no registry access at image build,
consistent with how the box already ships plain `.mjs` files. Its version lives
in the `node` catalog (`acorn`, exact-pinned) as an apps/cloud devDependency;
`__tests__/build-scan-vendor.test.ts` fails until the vendored bytes match the
installed release, so a bump is: change the catalog, `pnpm install`, copy
`node_modules/acorn/dist/acorn.mjs` and `LICENSE` over. The same test checks
that every module `server.mjs` imports is one the Dockerfile copies.

`server.mjs` imports the scanner statically, at start-up: `/srv` is writable by
the `node` user builds run as, so a module first loaded after a build ran could
be one that build replaced.

## Security posture

It runs **untrusted tenant code**: a `postinstall` and a build script are both
arbitrary code execution by design. The container is the boundary.

- Non-root (`USER node`), owning nothing but its own scratch directory.
- A fresh `mkdtemp` per build, removed in `finally` — two builds never see each
  other's `node_modules`, and no cache is shared across tenants.
- `spawn(..., { shell: false })` everywhere: arguments never become a shell
  string, so a branch or commit value cannot inject a command.
- Caps on everything tenant-controlled: source size, log line length, exec
  output, and a wall-clock kill on both install and build. The bundle scan
  caps the bundle, the sourcemap, its heap and its own time, reads only a
  regular-file `<module>.map` (or a `sourceMappingURL` that resolves beside the
  module), never reads a file a sourcemap names, and reports only repo-relative
  paths, capped.
- Start it with egress restricted to the package registry —
  `enableInternet: false` plus `allowedHosts` on the `defineContainer` side.

## Smoke test

`__tests__/build-box-worker.test.ts` drives `?runtime=worker` end to end against
a stand-in wrangler, and `__tests__/build-box-worker-wrangler.test.ts` runs the
real, repo-pinned wrangler (TOML config, shim bundle, both routes) with no
network.

The automated half of the contract (exec, routing, the pre-install guards) is
`apps/cloud/__tests__/build-container.test.ts` and needs no network. The
install-and-build half needs a registry, so it is this:

```bash
docker build -t lunora-build-box apps/cloud/containers/build
docker run --rm -p 8080:8080 lunora-build-box

# In another shell — against any project that depends on the Lunora CLI:
git archive --format=tar.gz --prefix=repo/ HEAD > /tmp/src.tgz
curl -sN -X POST localhost:8080/__lunora/build --data-binary @/tmp/src.tgz
```

Expect NDJSON log lines (any `{"advisory"}` records among them), then a final
`{"bundle":"…","bundleHash":"…"}`. `__tests__/build-container-scan.test.ts`
drives the whole route, scan included, against a stand-in CLI with no registry.

## Wiring

Done — the image is reachable from the control plane:

1. `lunora/containers.ts` declares it (`buildBox`), egress denied except the
   package registries, `standard-2` because a real `pnpm install` plus a
   bundler does not fit in the 1/16-vCPU default.
2. `BuildRunnerPorts.execute` drives it through `src/builds/container-exec.ts`,
   which reads the NDJSON and forwards each line to `buildLogs`.
3. `fetchSource` downloads the tarball with the GitHub App installation token
   (`downloadTarball` in `src/github/app.ts`, reusing the same cached token as
   the commit-status write-back).
4. The dispatcher runs once a minute from the Worker's own `scheduled()`, which
   calls `POST /v1/builds/dispatch` in-process (`src/builds/control-plane.ts`).
   It used to be a Lunora cron action; it moved because the `release` port —
   `src/builds/release.ts`, which hands the build to the same deploy core as
   `POST /v1/deploy` — needs the Worker's bindings, which an action lacks.

Two things to know before this runs for real:

- **`wrangler deploy` builds the Dockerfile with local Docker** and pushes it
  to the Cloudflare Registry, so whatever runs the deploy needs a Docker
  daemon. The container entry is repeated in every `env.*` block in
  `wrangler.jsonc` because wrangler inherits neither `containers` nor
  `durable_objects` into an environment — a top-level-only entry deploys a cell
  with the binding present and nothing behind it.
- **`fetchSource` still needs the GitHub App credential** (`GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY`). Without it a build fails in its first minute with
  that reason in `buildLogs`, which is deliberate — see the `unconfigured`
  note in `src/builds/control-plane.ts`.
