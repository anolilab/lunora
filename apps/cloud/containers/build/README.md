# The build box (GAPS.md A3)

The container image that turns a repo tarball into the single Worker module the
deploy path uploads. One throwaway instance per build.

This is the 🌐 half of A3. Everything around it — the `builds` table, the work
lease, `builds.claimNext`, the dispatcher, log streaming, commit-SHA dedup — is
already code-complete in `src/builds/`; what was missing was an image to run
`lunora build` in. `BuildRunnerPorts.execute` is still unwired: see **Wiring**.

## The contract

| Route                  | Purpose                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__lunora/build` | Body **is** the gzipped repo tarball. Responds NDJSON: `{"line"}` per output line as it happens, then `{"bundle","bundleHash"}` or `{"error"}`. |
| `POST /__lunora/exec`  | The `@lunora/container` exec contract, verbatim — `{command,args,cwd,env,timeoutMs}` → `{code,stdout,stderr}`.                                  |
| `GET /__lunora/health` | Readiness probe.                                                                                                                                |

**Why a build route and not just exec.** `BuildRunnerPorts.execute` receives the
source as an `ArrayBuffer` in the Worker, and exec has nowhere to put it — it
sends `{command,args,cwd,env}` and nothing else, so a 40MB tarball cannot travel
through it. Exec also buffers its whole response to parse it, capped at 1MB by
default; a real build log is bigger. Streaming NDJSON solves both and is what
lets the dashboard tail a build live, which is what `buildLogs` is for.

## What it does, and the two decisions inside it

1. Extract the tarball from the request body (`--strip-components=1` drops
   GitHub's `<owner>-<repo>-<sha>/` wrapper).
2. **Install with the manager the lockfile names** — `pnpm-lock.yaml` → pnpm,
   `package-lock.json` → npm, `yarn.lock` → yarn. Never a default: installing a
   pnpm project with npm resolves a different graph than the one the tenant
   tested, and it surfaces as a mystifying build error rather than as "wrong
   manager". No lockfile is refused.
3. **Run `node_modules/.bin/lunora build` directly** — not `pnpm exec`, not
   `npm exec`, not `yarn run`. Every manager's exec treats a missing binary as
   "fetch it from the registry": verified against npm 10, where both
   `npm exec --no --` and `npx --no` still resolve from the network. A project
   that never declared the CLI would therefore be built by whatever version is
   latest that day — an unpinned toolchain swap, silent, with `404 lunora` as
   the only clue. The `.bin` path can only be the version the lockfile
   installed, and its absence is a clear error. (Yarn PnP writes no `.bin` and
   is refused rather than guessed at.)
4. Collect the built module and hash it. The deploy path uploads exactly **one**
   `main_module` (`src/cloudflare/api.ts` sets a single form part), so a build
   that produced several modules is refused here rather than deployed as
   whichever file sorted first — that would ship a Worker missing half its code,
   first noticed as a runtime import error in production.

## Security posture

It runs **untrusted tenant code**: a `postinstall` and a build script are both
arbitrary code execution by design. The container is the boundary.

- Non-root (`USER node`), owning nothing but its own scratch directory.
- A fresh `mkdtemp` per build, removed in `finally` — two builds never see each
  other's `node_modules`, and no cache is shared across tenants.
- `spawn(..., { shell: false })` everywhere: arguments never become a shell
  string, so a branch or commit value cannot inject a command.
- Caps on everything tenant-controlled: source size, log line length, exec
  output, and a wall-clock kill on both install and build.
- Start it with egress restricted to the package registry —
  `enableInternet: false` plus `allowedHosts` on the `defineContainer` side.

## Smoke test

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

Expect NDJSON log lines, then a final `{"bundle":"…","bundleHash":"…"}`.

## Wiring (still open)

The image exists; nothing calls it yet. To close A3:

1. `defineContainer` this image in the cloud app (`image: "./containers/build"`,
   `enableInternet: false`, `allowedHosts` for the registry, an instance type
   with enough memory for a real `pnpm install`).
2. Implement `BuildRunnerPorts.execute` over
   `ctx.containers.<name>.fetch("/__lunora/build", { body: source })`, parsing
   the NDJSON and calling `onLine` per `{"line"}`.
3. Implement `fetchSource` — the GitHub App installation token is already
   minted by `src/github/app.ts`; this is the tarball download.
4. Wire `src/builds/dispatch.ts` into `scheduled()`. It is deliberately not
   wired today: claiming builds with no executor would only burn them.
