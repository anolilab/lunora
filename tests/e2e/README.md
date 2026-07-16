# @lunora/e2e

End-to-end Playwright + Miniflare test suite covering the full client →
Vite → Worker → DO → response pipeline of the Lunora playground app.

## Quick start

```bash
# from repo root
pnpm install
pnpm e2e
```

The first run downloads Playwright browsers (~250 MB). Subsequent runs
re-use the local browser cache.

## What this suite covers

| File                     | What it proves                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`           | Sign-up / sign-in / sign-out / weak-password rejection via `@lunora/auth`                                      |
| `auth-rls.spec.ts`       | Two users, RLS-guarded `notes` — one user's rows never reach the other, over live WS subscriptions AND raw RPC |
| `subscriptions.spec.ts`  | Real-time WS deltas between tabs, offline queue + replay                                                       |
| `offline-replay.spec.ts` | Several mutations queued offline replay in authored order on reconnect; a second tab converges                 |
| `sharding.spec.ts`       | `shardBy("channelId")` isolates state across DOs; two clients on the SAME shard converge both ways             |
| `optimistic.spec.ts`     | `useMutation` shows pending instantly, then either confirms or rolls back                                      |
| `r2-storage.spec.ts`     | Signed URL PUT/GET round-trip through Miniflare R2, expiry returns 403                                         |
| `scaffold.spec.ts`       | `lunora init` (BUILT CLI bin, offline `--from templates`) → `lunora codegen` → the scaffold typechecks         |
| `scheduler.spec.ts`      | `ctx.scheduler.runAfter` fires the job within the wall-clock budget (skipped — see Limitations)                |

## How the harness boots

`globalSetup.ts` starts the playground exactly like `pnpm dev`: one `vite
--port 5173 --strictPort` whose embedded `@cloudflare/vite-plugin` worker
(Miniflare under the hood) is the **single** backend for auth, RPC, WebSockets,
R2, and the `/test/*` helpers — all on one D1, same origin. There is no second
standalone worker (a separate one would have its own D1 and split auth state
from the RPC/WS state).

The worker's env comes from a deterministic `.dev.vars` the harness writes on
boot (and restores on teardown): `AUTH_SECRET`, `STORAGE_SECRET`,
`PUBLIC_STORAGE_BASE_URL`/`LUNORA_ORIGIN_URL`/`LUNORA_WORKER_ORIGIN` (all the
worker origin), and `LUNORA_E2E=true`. The `LUNORA_E2E` flag gates the
`/test/reset`, `/test/sign`, `/test/schedule`, and `/test/job-status` routes the
suite relies on — see
[`apps/playground/src/server/index.ts`](../../apps/playground/src/server/index.ts).
Storage is ephemeral (`persistState: false`) so each run starts from a clean
DO / D1 / R2.

Boot reliability (each item below was an observed failure mode):

- The Vite child's output is captured into a ring buffer and included in any
  boot-failure error (`E2E_VERBOSE=true` streams it instead).
- The boot budget is 180 s — a cold Vite dep-optimizer cache plus the first
  wrangler/Miniflare init can exceed a minute on constrained runners.
- If the child exits during boot, setup fails immediately with its output
  rather than polling a dead port for the whole budget.
- Port 5173 is probed **before** spawning: a stale server (leaked child of a
  crashed run, a dev's `pnpm dev`) fails the run with an explicit conflict
  error instead of silently testing against unknown state. Set
  `LUNORA_E2E_EXTERNAL=true` to intentionally target an already-running
  playground.

`globalTeardown.ts` kills the whole process **group** (pnpm → node → vite →
workerd; SIGTERM, then SIGKILL after 5 s), waits for the real `exit` event,
and restores the developer's `.dev.vars`. The group kill matters: signalling
only the direct child used to orphan workerd, which kept :5173 bound and broke
the next run's boot.

## Running variants

```bash
# Headed mode — see the browser
pnpm --filter @lunora/e2e e2e:headed

# Playwright inspector / step debugger
pnpm --filter @lunora/e2e e2e:debug

# Time-travel viewer for the latest run
pnpm --filter @lunora/e2e exec playwright show-trace test-results/**/trace.zip
```

## Speed and stability

- **Wall-clock target:** ~60 s for the full Chromium run on a modern dev box.
  Cold start adds Vite + worker boot time.
- **`workers: 1` / `fullyParallel: false`** — every spec talks to ONE shared
  backend (one Vite worker, one D1, shared DO namespaces) and each test starts
  with `/test/reset` wiping that shared state; parallel workers would race
  each other's resets. This is the stability boundary, not a workaround.
- **Firefox** runs when its browser binary is installed (CI installs it);
  otherwise the project is dropped with a warning instead of hard-failing
  every Firefox test on a Chromium-only machine.
- **No hard sleeps** except where wall-clock time is itself under test
  (`scheduler.spec.ts` cron timing, `r2-storage.spec.ts` signed-URL expiry).
- **`/test/reset`** is called before every test so they are
  order-independent.

## CI gate

The `e2e` job in `.github/workflows/test.yml` runs the suite on pull requests
when e2e-relevant paths change (the `files-changed` paths filter). It is _not_
part of `pnpm test`, so unit-test runs stay fast. `nightly.yml` runs the suite
unconditionally every night. There is deliberately **no** skip escape hatch —
a red suite is a signal to fix, not to mute.

## Limitations

- The suite is offline-only — no Cloudflare account, no real WAF / Argo /
  Workers AI. Tests that would require those features (e.g. real OAuth
  callbacks, real Workers AI inference) are not present.
- **`scheduler.spec.ts` is skipped** in this harness: Durable Object alarms
  don't fire in `@cloudflare/vite-plugin`'s embedded dev Miniflare, so a
  scheduled job never dispatches. The scheduler is exercised against a
  standalone `wrangler dev` / production instead.
- **`scaffold.spec.ts` does not run a real `pnpm install`**: the template's
  `@lunora/*`/`lunorash` versions aren't on npm from a monorepo checkout, so
  the workspace packages are symlinked in (their built `dist/`) and the
  scaffold is verified with `lunora codegen` + `tsc --noEmit`. The remote
  registry path is covered by `scripts/clean-machine-smoke.sh`.
- **`optimistic.spec.ts`'s rollback case is `fixme`'d**: the optimistic row
  isn't observable when the failing mutation is mocked via Playwright's
  `route` (the insert + rollback collapse into one paint). The optimistic
  _render_ path is still covered by the sibling assertion.
- There is no Vite-overlay test: `@visulima/vite-overlay` only renders real,
  source-mappable errors, which a synthetic event can't drive — the overlay is
  third-party (with its own tests) and is exercised by real dev usage.
