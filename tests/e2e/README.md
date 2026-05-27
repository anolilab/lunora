# @cirrus/e2e

End-to-end Playwright + Miniflare test suite covering the full client →
Vite → Worker → DO → response pipeline of the Cirrus playground app.

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
| `auth.spec.ts`          | Sign-up / sign-in / sign-out / weak-password rejection via `@cirrus/auth`                         |
| `subscriptions.spec.ts` | Real-time WS deltas between tabs, offline queue + replay                                          |
| `sharding.spec.ts`      | `shardBy("channelId")` isolates state across DOs; a failed shard doesn't bring down its neighbour |
| `optimistic.spec.ts`    | `useMutation` shows pending instantly, then either confirms or rolls back                         |
| `r2-storage.spec.ts`    | Signed URL PUT/GET round-trip through Miniflare R2, expiry returns 403                            |
| `scheduler.spec.ts`     | `ctx.scheduler.runAfter` fires the job within the wall-clock budget                               |
| `error-overlay.spec.ts` | `@visulima/vite-overlay` surfaces server errors and clears on HMR update                          |

## How the harness boots

`globalSetup.ts` spawns two child processes:

1. `wrangler dev --local --port 8787` (= Miniflare under the hood). Reads
   `apps/playground/wrangler.jsonc` for DO / D1 / R2 bindings.
2. `vite --port 5173 --strictPort` for the playground SPA.

Both pick `CIRRUS_E2E=true` and `AUTH_SECRET=e2e-deterministic-secret-...`
from the temp `.dev.vars` file the harness writes on boot. The
`CIRRUS_E2E` env flag is what gates the `/test/reset`, `/test/sign`,
`/test/schedule`, `/test/job-status`, and `/test/throw` routes that the
suite relies on — see
[`apps/playground/src/server/index.ts`](../../apps/playground/src/server/index.ts).

`globalTeardown.ts` SIGTERMs both children, then SIGKILL after 750ms.

## Running variants

```bash
# Headed mode — see the browser
pnpm --filter @cirrus/e2e e2e:headed

# Playwright inspector / step debugger
pnpm --filter @cirrus/e2e e2e:debug

# Time-travel viewer for the latest run
pnpm --filter @cirrus/e2e exec playwright show-trace test-results/**/trace.zip

# Skip the suite entirely (CI flake escape hatch)
CIRRUS_E2E=skip pnpm e2e
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
fast. To skip on a known-flaky runner, set `CIRRUS_E2E=skip` in the job
env.

## Limitations

- The suite is offline-only — no Cloudflare account, no real WAF / Argo /
  Workers AI. Tests that would require those features (e.g. real OAuth
  callbacks, real Workers AI inference) are not present.
- The Vite overlay test fires synthetic `vite:error` events instead of
  editing source on disk — touching source would race the HMR runtime and
  flake. Live HMR is exercised by `apps/playground` smoke tests instead.
