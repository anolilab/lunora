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

| File                    | What it proves                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`          | Sign-up / sign-in / sign-out / weak-password rejection via `@lunora/auth`                         |
| `subscriptions.spec.ts` | Real-time WS deltas between tabs, offline queue + replay                                          |
| `sharding.spec.ts`      | `shardBy("channelId")` isolates state across DOs; a failed shard doesn't bring down its neighbour |
| `optimistic.spec.ts`    | `useMutation` shows pending instantly, then either confirms or rolls back                         |
| `r2-storage.spec.ts`    | Signed URL PUT/GET round-trip through Miniflare R2, expiry returns 403                            |
| `scheduler.spec.ts`     | `ctx.scheduler.runAfter` fires the job within the wall-clock budget (skipped — see Limitations)   |

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

`globalTeardown.ts` SIGTERMs the Vite child (SIGKILL after 750ms) and restores
the developer's `.dev.vars`.

## Running variants

```bash
# Headed mode — see the browser
pnpm --filter @lunora/e2e e2e:headed

# Playwright inspector / step debugger
pnpm --filter @lunora/e2e e2e:debug

# Time-travel viewer for the latest run
pnpm --filter @lunora/e2e exec playwright show-trace test-results/**/trace.zip

# Skip the suite entirely (CI flake escape hatch)
LUNORA_E2E=skip pnpm e2e
```

## Speed and stability

- **Wall-clock target:** ~30 s for the full Chromium + Firefox run on a
  modern dev box (8-core, NVMe). Cold start adds ~5 s for the Vite + worker
  boot.
- **`workers: 1`** — DO state is shared, so parallel workers would race.
- **No hard sleeps** except in `scheduler.spec.ts` (cron timing is the
  point) and `r2-storage.spec.ts`'s expiry test.
- **`/test/reset`** is called before every test so they are
  order-independent.

## CI gate

The `e2e` job in `.github/workflows/test.yml` runs the suite **on pull
requests only**. It is _not_ part of `pnpm test`, so unit-test runs stay
fast. To skip on a known-flaky runner, set `LUNORA_E2E=skip` in the job
env.

## Limitations

- The suite is offline-only — no Cloudflare account, no real WAF / Argo /
  Workers AI. Tests that would require those features (e.g. real OAuth
  callbacks, real Workers AI inference) are not present.
- **`scheduler.spec.ts` is skipped** in this harness: Durable Object alarms
  don't fire in `@cloudflare/vite-plugin`'s embedded dev Miniflare, so a
  scheduled job never dispatches. The scheduler is exercised against a
  standalone `wrangler dev` / production instead.
- **`optimistic.spec.ts`'s rollback case is `fixme`'d**: the optimistic row
  isn't observable when the failing mutation is mocked via Playwright's
  `route` (the insert + rollback collapse into one paint). The optimistic
  _render_ path is still covered by the sibling assertion.
- There is no Vite-overlay test: `@visulima/vite-overlay` only renders real,
  source-mappable errors, which a synthetic event can't drive — the overlay is
  third-party (with its own tests) and is exercised by real dev usage.
